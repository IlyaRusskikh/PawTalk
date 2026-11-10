#!/usr/bin/env python3
"""Opt-in Swarm updates. No shell evaluation, floating tags, or remote scripts."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request

VERSION = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
ROOT = Path(__file__).resolve().parent.parent


def read_config(file):
    values = {}
    for number, line in enumerate(Path(file).read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"PAWTALK_[A-Z0-9_]+", key):
            raise ValueError(f"Invalid configuration line {number}")
        if key in values or any(character in value for character in "\x00\r\n"):
            raise ValueError(f"Invalid or repeated configuration key: {key}")
        values[key] = value.strip()
    if values.get("PAWTALK_AUTO_UPDATE", "false") not in ("true", "false"):
        raise ValueError("PAWTALK_AUTO_UPDATE must be true or false")
    if values.get("PAWTALK_UPDATE_CHANNEL", "preview") not in ("stable", "preview"):
        raise ValueError("Invalid update channel")
    if not REPOSITORY.fullmatch(values.get("PAWTALK_UPDATE_REPOSITORY", "IlyaRusskikh/pawtalk")):
        raise ValueError("Invalid update repository")
    return values


def docker(*arguments, env=None):
    return subprocess.run(["docker", *arguments], check=True, text=True, stdout=subprocess.PIPE, env=env).stdout.strip()


def get_json(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "PawTalk-server-updater", **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("Update metadata too large")
        return json.loads(raw), response.headers


def release_digest(body, repository):
    """Recognize both published GHCR release-note format and older digest-only notes.

    A fully qualified digest must belong to the configured PawTalk server image.
    Reject conflicting digest declarations rather than selecting one arbitrarily.
    The selected digest is also compared with GHCR before any update.
    """
    image = "ghcr.io/" + repository.lower() + "-server"
    formats = (
        rf"(?m)^Published multi-platform server digest:[ \t]*`?{re.escape(image)}@(sha256:[a-f0-9]{{64}})`?(?=[. \t]|$)",
        r"(?m)^Server image digest:[ \t]*`?(sha256:[a-f0-9]{64})`?(?=[. \t]|$)",
    )
    digests = {found.group(1) for pattern in formats for found in re.finditer(pattern, body)}
    return next(iter(digests)) if len(digests) == 1 else None


def select_release(releases, channel, repository="IlyaRusskikh/pawtalk"):
    candidates = []
    for release in releases:
        match = VERSION.fullmatch(str(release.get("tag_name", "")))
        digest = release_digest(release.get("body") or "", repository)
        if not match or not digest or release.get("draft") or (channel == "stable" and release.get("prerelease")):
            continue
        candidates.append((tuple(map(int, match.groups())), release["tag_name"].removeprefix("v"), digest))
    return max(candidates, default=None)


def registry_digest(repository, version):
    image = repository.lower() + "-server"
    auth, _ = get_json("https://ghcr.io/token?service=ghcr.io&scope=" + urllib.parse.quote("repository:" + image + ":pull", safe=""))
    _, headers = get_json("https://ghcr.io/v2/" + image + "/manifests/" + version, {
        "Authorization": "Bearer " + auth["token"],
        "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    })
    digest = headers.get("Docker-Content-Digest", "")
    if not DIGEST.fullmatch(digest):
        raise ValueError("Registry did not return a valid image digest")
    return digest


def update(values, stack, check_only=False):
    if not check_only and values.get("PAWTALK_AUTO_UPDATE", "false") != "true":
        print("Automatic server updates disabled; no network request or deployment performed.")
        return
    repository = values.get("PAWTALK_UPDATE_REPOSITORY", "IlyaRusskikh/pawtalk")
    expected_image = "ghcr.io/" + repository.lower() + "-server"
    service = json.loads(docker("service", "inspect", stack + "_server"))[0]
    labels = service["Spec"].get("Labels", {})
    current_image = service["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"]
    if labels.get("io.pawtalk.managed") != "true" or not current_image.startswith(expected_image + ":") and not current_image.startswith(expected_image + "@"):
        raise ValueError("Service is not a managed PawTalk image from the configured repository")
    current = VERSION.fullmatch(labels.get("io.pawtalk.version", ""))
    if not current:
        raise ValueError("Service has no valid io.pawtalk.version label; deploy using the Swarm configuration")
    releases, _ = get_json("https://api.github.com/repos/" + repository + "/releases?per_page=100", {"Accept": "application/vnd.github+json"})
    if not isinstance(releases, list):
        raise ValueError("Invalid release response")
    selected = select_release(releases, values.get("PAWTALK_UPDATE_CHANNEL", "preview"), repository)
    if not selected or selected[0] <= tuple(map(int, current.groups())):
        print("Server is up to date: " + labels["io.pawtalk.version"])
        return
    _, version, digest = selected
    if registry_digest(repository, version) != digest:
        raise ValueError("Registry digest differs from the published release; update cancelled")
    print("Available server update: " + version + " (" + digest + ")")
    if check_only:
        return
    # Swarm replaces the one stateful task and restores PreviousSpec on failure.
    image = expected_image + "@" + digest
    docker("pull", image)
    print(docker("service", "update", "--detach=false", "--image", image,
                 "--label-add", "io.pawtalk.version=" + version,
                 "--update-order", "stop-first", "--update-parallelism", "1",
                 "--update-failure-action", "rollback", "--update-monitor", "60s", stack + "_server"))
    final = json.loads(docker("service", "inspect", stack + "_server"))[0]
    if final["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"] != image or final.get("UpdateStatus", {}).get("State") != "completed":
        raise RuntimeError("Update did not complete; inspect docker service ps and the rollback status")
    print("Server updated to " + version)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("deploy", "update", "check", "rollback"))
    parser.add_argument("--config", type=Path, default=Path(".env"))
    parser.add_argument("--stack", default="pawtalk")
    arguments = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", arguments.stack):
        raise ValueError("Invalid stack name")
    values = read_config(arguments.config)
    if arguments.action == "deploy":
        required = ("PAWTALK_IMAGE", "PAWTALK_DATA_VOLUME", "PAWTALK_PUBLIC_IP")
        if any(not values.get(name) for name in required):
            raise ValueError("Set PAWTALK_IMAGE, PAWTALK_DATA_VOLUME and PAWTALK_PUBLIC_IP")
        env = {**os.environ, **values}
        print(docker("stack", "deploy", "--resolve-image", "always", "--compose-file", str(ROOT / "compose.server.swarm.yaml"), arguments.stack, env=env))
    elif arguments.action == "rollback":
        print(docker("service", "update", "--rollback", "--detach=false", arguments.stack + "_server"))
    elif arguments.action == "check":
        update(values, arguments.stack, check_only=True)
    elif values.get("PAWTALK_AUTO_UPDATE", "false") != "true":
        update(values, arguments.stack)
    else:
        import fcntl
        with open("/run/pawtalk-update.lock", "w", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print("Another server update is running"); return
            update(values, arguments.stack)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print("PawTalk server update: " + str(error), file=sys.stderr)
        sys.exit(1)
