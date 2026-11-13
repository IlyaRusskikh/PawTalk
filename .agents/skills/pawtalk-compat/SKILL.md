---
name: pawtalk-compat
description: Review PawTalk API, capabilities, storage, updater or shared-server changes for compatibility across Client, Server and Manager.
metadata:
  short-description: Preserve independent component contracts
---

1. Read [invariants](../../../agents/architecture/invariants.md) and
   [compatibility matrix](../../../docs/COMPATIBILITY.md).
2. Identify both consumers and producers, legacy missing fields, explicit unknown
   values, data/launcher schemas and signed metadata. Release numbers are independent.
3. Keep Client selfhost and Server serve on one server/ implementation and identical
   build tooling. Update the matrix for changed contracts; use server-first transitions.
4. Select current+published-peer integration checks from
   [test routing](../../../agents/testing/README.md), including frozen fixtures.
5. Report breaking/unsupported cases and tested environments. Document substantial
   design changes in agents/decisions/; do not claim installed binaries changed.
