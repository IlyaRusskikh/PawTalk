import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json

spec = importlib.util.spec_from_file_location("pawtalk_updater", Path(__file__).resolve().parents[1] / "scripts/server-update.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
DIGEST = "sha256:" + "a" * 64
# Exact multi-platform digest format copied from the published v0.7.1 release notes.
PUBLISHED_DIGEST = "sha256:f125d309b2a64d0504b7aa70c8a84047271a8d672fc912f4a65cd18bfcdec667"


class ServerUpdateTests(unittest.TestCase):
    def release(self, version="0.5.0", preview=False):
        return {"tag_name": "v" + version, "draft": False, "prerelease": preview, "body": "Server image digest: `" + DIGEST + "`."}

    def test_version_and_channel_selection(self):
        releases = [self.release("0.4.9"), self.release("0.5.0", True), self.release("0.4.10")]
        self.assertEqual(updater.select_release(releases, "stable")[1], "0.4.10")
        self.assertEqual(updater.select_release(releases, "preview")[1], "0.5.0")
        self.assertIsNone(updater.select_release([{**self.release(), "draft": True}], "preview"))
        self.assertIsNone(updater.select_release([{**self.release(), "tag_name": "v0.5.0;bad"}], "preview"))

    def test_published_release_note_digest_is_selected(self):
        notes = (
            "Server: docker pull ghcr.io/ilyarusskikh/pawtalk-server:0.7.1 (linux/amd64, linux/arm64).\\n\\n"
            "Published multi-platform server digest: `ghcr.io/ilyarusskikh/pawtalk-server@"
            + PUBLISHED_DIGEST + "`.\\n"
        )
        release = {"tag_name": "v0.7.1", "draft": False, "prerelease": True, "body": notes}
        self.assertEqual(updater.release_digest(notes, "IlyaRusskikh/pawtalk"), PUBLISHED_DIGEST)
        self.assertEqual(updater.select_release([release], "preview"), ((0, 7, 1), "0.7.1", PUBLISHED_DIGEST))
        self.assertIsNone(updater.select_release([release], "stable"))

    def test_release_note_digest_rejects_foreign_images_ambiguity_and_bad_hex(self):
        prefix = "Published multi-platform server digest: `ghcr.io/"
        canonical = prefix + "ilyarusskikh/pawtalk-server@" + PUBLISHED_DIGEST + "`."
        foreign = prefix + "another-owner/pawtalk-server@" + PUBLISHED_DIGEST + "`."
        self.assertIsNone(updater.release_digest(foreign, "IlyaRusskikh/pawtalk"))
        self.assertIsNone(updater.release_digest(canonical, "different-owner/pawtalk"))
        self.assertIsNone(updater.release_digest(canonical.replace("sha256:", "sha256:ZZ"), "IlyaRusskikh/pawtalk"))
        self.assertIsNone(updater.release_digest(canonical + "\\nServer image digest: `" + DIGEST + "`.", "IlyaRusskikh/pawtalk"))
        self.assertEqual(updater.release_digest("Server image digest: `" + DIGEST + "`.", "IlyaRusskikh/pawtalk"), DIGEST)

    def test_live_release_format_can_pass_read_only_check(self):
        release = {
            "tag_name": "v0.7.1", "draft": False, "prerelease": True,
            "body": "Published multi-platform server digest: "
                    "`ghcr.io/ilyarusskikh/pawtalk-server@" + PUBLISHED_DIGEST + "`.",
        }
        service = {
            "Spec": {
                "Labels": {"io.pawtalk.managed": "true", "io.pawtalk.version": "0.7.0"},
                "TaskTemplate": {"ContainerSpec": {"Image": "ghcr.io/ilyarusskikh/pawtalk-server:0.7.0"}},
            },
        }
        with patch.object(updater, "docker", return_value=json.dumps([service])) as docker, \\
                patch.object(updater, "get_json", return_value=([release], {})), \\
                patch.object(updater, "registry_digest", return_value=PUBLISHED_DIGEST) as registry:
            updater.update({"PAWTALK_AUTO_UPDATE": "false"}, "pawtalk", check_only=True)
            registry.assert_called_once_with("IlyaRusskikh/pawtalk", "0.7.1")
            docker.assert_called_once_with("service", "inspect", "pawtalk_server")

    def test_disabled_does_not_contact_network_or_docker(self):
        with patch.object(updater, "get_json") as network, patch.object(updater, "docker") as docker:
            updater.update({"PAWTALK_AUTO_UPDATE": "false"}, "pawtalk")
            network.assert_not_called(); docker.assert_not_called()

    def test_config_is_data_and_duplicate_keys_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / ".env"
            file.write_text("PAWTALK_AUTO_UPDATE=false\nPAWTALK_PUBLIC_IP=$(touch bad)\n")
            self.assertEqual(updater.read_config(file)["PAWTALK_PUBLIC_IP"], "$(touch bad)")
            file.write_text("PAWTALK_AUTO_UPDATE=false\nPAWTALK_AUTO_UPDATE=true\n")
            with self.assertRaises(ValueError): updater.read_config(file)

    def test_digest_mismatch_never_pulls_or_updates(self):
        service = {"Spec": {"Labels": {"io.pawtalk.managed": "true", "io.pawtalk.version": "0.4.1"}, "TaskTemplate": {"ContainerSpec": {"Image": "ghcr.io/ilyarusskikh/pawtalk-server:0.4.1"}}}}
        with patch.object(updater, "docker", return_value=json.dumps([service])) as docker, patch.object(updater, "get_json", return_value=([self.release()], {})), patch.object(updater, "registry_digest", return_value="sha256:" + "b" * 64):
            with self.assertRaises(ValueError): updater.update({"PAWTALK_AUTO_UPDATE": "true"}, "pawtalk")
            self.assertEqual(docker.call_count, 1)

    def test_success_is_digest_pinned_and_waits_for_rollout(self):
        image = "ghcr.io/ilyarusskikh/pawtalk-server"
        initial = {"Spec": {"Labels": {"io.pawtalk.managed": "true", "io.pawtalk.version": "0.4.1"}, "TaskTemplate": {"ContainerSpec": {"Image": image + ":0.4.1"}}}}
        final = {"Spec": {"TaskTemplate": {"ContainerSpec": {"Image": image + "@" + DIGEST}}}, "UpdateStatus": {"State": "completed"}}
        with patch.object(updater, "docker", side_effect=[json.dumps([initial]), "pulled", "updated", json.dumps([final])]) as docker, patch.object(updater, "get_json", return_value=([self.release()], {})), patch.object(updater, "registry_digest", return_value=DIGEST):
            updater.update({"PAWTALK_AUTO_UPDATE": "true"}, "pawtalk")
            args = docker.call_args_list[2].args
            self.assertIn("--detach=false", args); self.assertIn(image + "@" + DIGEST, args); self.assertIn("rollback", args)

    def test_rollback_is_reported_as_a_failed_update(self):
        service = {"Spec": {"Labels": {"io.pawtalk.managed": "true", "io.pawtalk.version": "0.4.1"}, "TaskTemplate": {"ContainerSpec": {"Image": "ghcr.io/ilyarusskikh/pawtalk-server:0.4.1"}}}}
        rolled_back = {**service, "UpdateStatus": {"State": "rollback_completed"}}
        with patch.object(updater, "docker", side_effect=[json.dumps([service]), "pulled", "rolled back", json.dumps([rolled_back])]), patch.object(updater, "get_json", return_value=([self.release()], {})), patch.object(updater, "registry_digest", return_value=DIGEST):
            with self.assertRaises(RuntimeError): updater.update({"PAWTALK_AUTO_UPDATE": "true"}, "pawtalk")


if __name__ == "__main__": unittest.main()
