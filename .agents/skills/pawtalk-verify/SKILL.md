---
name: pawtalk-verify
description: Select and run PawTalk checks for a change, review or pre-push verification; report coverage and unavailable environments.
metadata:
  short-description: Route and verify affected PawTalk changes
---

1. Read [test routing](../../../agents/testing/README.md) and the changed diff.
2. Run `node tooling/ci/test-plan.mjs --diff origin/main`; inspect cross-component
   effects against the [map](../../../agents/architecture/components.md).
3. Reuse successful checks only if their covered state/environment has not changed.
   During implementation use targeted checks; before push run affected baselines
   and integration from check.yml. A build is not an integration substitute.
4. Inspect exit codes and final summaries first. For long logs, search for runner
   failure markers (for example `not ok`, `FAIL`, `Error`, `Traceback`) and read
   surrounding context instead of reading all output sequentially. Keep the full
   log available; broaden inspection when summaries are missing, output is
   truncated, or failures remain unexplained. No search matches alone do not prove
   success. Fix failures and rerun affected checks. Run check:public and review
   staged diff. Record synthetic/container/native/hardware distinctions.
5. Hand off exact passed/unavailable checks and direct PR CI link. Do not watch CI
   unless requested; do not infer merge/tag/publication approval.
