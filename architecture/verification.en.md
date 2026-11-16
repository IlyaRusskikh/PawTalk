# Verification and limits of evidence

[Русский](verification.ru.md) · [Index](README.md)

PawTalk uses layered checks; they are **not interchangeable**.

| Level | What it can demonstrate | What it cannot |
| --- | --- | --- |
| Type/unit/security tests | Local logic, protocol rejection, cryptographic framing and predictable errors | Real devices, WAN reachability, OS service behavior |
| API/integration harnesses | Membership, channels, invitations, message persistence and expected Server interactions | Physical microphone/PTT/games |
| Docker/Compose lifecycle | Linux container health, update/restore transactions, volumes and configuration | A real host's systemd boot behavior, router/ISP UDP |
| Windows service/install tests | Windows SCM/UAC/service lifecycle on tested CI images | Every Windows edition or external network |
| Published release validation | Signed bytes, hashes, release notes and tag compatibility | Automatically proven user experience |

The published API 2 preview has synthetic and CI coverage, but **real hardware, remote TCP/UDP, audio latency/quality and game PTT acceptance must be reported as separate evidence**. A check passing for `main` does not retroactively change a published tag.

When updating documents, compare claims with published release descriptions and tests; preserve limitations and distinguish targets from validated platforms. Run `node scripts/check-release-notes.mjs` and relevant checks after changing release content, plus `node scripts/check-website.mjs` for website changes. See [testing rules](../agents/testing/README.md) and [CI](../.github/workflows/check.yml).
