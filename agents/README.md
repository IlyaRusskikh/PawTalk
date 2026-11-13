# Agent knowledge index

Read [../AGENTS.md](../AGENTS.md) first. Load only the row relevant to the task;
source code and executable contracts outrank stale descriptive documentation.

| Task | Context | Skill |
| --- | --- | --- |
| Locate ownership/dependencies | [Component map](architecture/components.md) | — |
| Any change, branch, PR | [Development rules](rules/development.md), [test routing](testing/README.md) | [pawtalk-verify](../.agents/skills/pawtalk-verify/SKILL.md) |
| API, storage, shared core, updater | [Compatibility](../docs/COMPATIBILITY.md), [invariants](architecture/invariants.md) | [pawtalk-compat](../.agents/skills/pawtalk-compat/SKILL.md) |
| Auth, crypto, downloads, trust boundaries | [Security](../SECURITY.md), [invariants](architecture/invariants.md) | [pawtalk-security](../.agents/skills/pawtalk-security/SKILL.md) |
| Release preparation/publication | [Release process](../docs/RELEASING.md), [GitHub setup](rules/github.md) | [pawtalk-release](../.agents/skills/pawtalk-release/SKILL.md) |
| Agent/CI/catalog infrastructure | [Decision 001](decisions/001-agent-and-release-infrastructure.md), [official sources](rules/tooling.md) | pawtalk-verify |

Product/operator guides live in [docs/](../docs/README.md). Historical verification
logs are evidence for their dated state, not a current test checklist. Public
versions come from GitHub Releases; source manifests describe the development tree.

Codex discovers `.agents/skills/`. Claude Code imports `AGENTS.md` through
`CLAUDE.md`; Gemini CLI through `GEMINI.md`. Cursor and Copilot have short native
entry points. These adapters share rules, not tool permissions or automatic skill
discovery guarantees. In an agent without skill discovery, read the linked SKILL.md
when the task matches; no copies/symlinks of the knowledge base are necessary.
