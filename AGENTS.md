# Working on PawTalk

Mandatory entry point for every agent. Read [agents/README.md](agents/README.md),
then only the relevant rules/skills. Use the [component map](agents/architecture/components.md)
before broad search; verify descriptive docs against code.

- Work in branches from current main; never commit directly to main. Follow
  [Git/development rules](agents/rules/development.md). Working-branch pushes are
  allowed within the task after final checks. Merge, tag and publication each need
  separate explicit owner permission. Default merge is squash, then delete branch.
- Preserve AGPL-3.0-only, third-party notices, architecture and independent
  Client/Server/Manager contracts. No secrets, live invitations, personal data,
  CONTINUE.md, generated files, downloaded tools or build output in Git. No new production
  dependencies without agreement.
- Route checks with [agents/testing/README.md](agents/testing/README.md).
  Run affected final-candidate CI locally before push, inspect exit codes/output,
  run npm run check:public and review staged diff. Reuse successful checks only
  while covered inputs/code/config/dependencies/environment remain unchanged.
  Report unavailable checks; distinguish synthetic, integration, container,
  native and hardware/external-network verification. Do not hide failures.
- Keep English/Russian READMEs aligned; technical detail belongs in docs/ and
  SECURITY.md. Follow shared form geometry, action-button alignment and enum
  localization rules in [development rules](agents/rules/development.md).
- Releases follow [docs/RELEASING.md](docs/RELEASING.md). Never replace published
  tags/binaries/images. Public versions and download links derive from GitHub
  Releases, not package versions or a global releases/latest endpoint.
- After PR creation give its CI link and hand control to the owner. Do not watch
  CI without explicit instruction. Silence is not approval to merge/tag/publish.
