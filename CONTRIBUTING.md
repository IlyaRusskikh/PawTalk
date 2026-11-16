# Contributing to PawTalk

[Русский](CONTRIBUTING.ru.md)

Start with [README.md](README.md). Fork the repository, create a branch, make a
focused change and open a pull request describing the problem, the resulting
behavior and how you checked it. Add or update tests when behavior changes.
Keep both root READMEs current when changing setup or user-facing features.
Contributions are made under the project's `AGPL-3.0-only` license.

Use [AGENTS.md](AGENTS.md) and [verification routing](agents/testing/README.md)
for affected checks before pushing. Open a focused PR from current main; squash
merge requires successful PR CI and explicit owner approval. Report unavailable
checks. Do not watch CI unless asked.

Never include room passwords, invitations, E2EE keys, TLS private keys, personal
recordings, local diagnostics or `manager/generated/`. Replace real addresses
with documentation examples. Inspect `git diff --cached` before committing.
For a suspected security issue, use GitHub's private vulnerability reporting
if enabled; never post credentials in a public issue.
Release steps are in [architecture/releasing.en.md](architecture/releasing.en.md).
