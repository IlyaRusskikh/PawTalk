# Native tooling references

Checked against official documentation on 2026-11-13. Recheck when changing these
mechanisms; avoid rereading vendor docs for ordinary product tasks.

- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  and [skills](https://learn.chatgpt.com/docs/build-skills): short durable rules,
  repo .agents/skills, name/description metadata and progressive context loading.
- [Claude Code memory](https://code.claude.com/docs/en/memory) and
  [Gemini context imports](https://geminicli.com/docs/cli/gemini-md/): native files
  import the root entry point; local tool permissions remain independent.
- [Cursor rules](https://cursor.com/docs/rules) and
  [Copilot instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions): thin native adapters reference the shared index.
- [GitHub events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
  [environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
  [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets): PR-only development verification, environment jobs after build,
  explicit main ancestry and immutable tags; settings require owner setup.
