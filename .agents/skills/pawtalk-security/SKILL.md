---
name: pawtalk-security
description: Review or change PawTalk authentication, invitations, E2EE, IPC, signed downloads, host operations or release trust boundaries.
metadata:
  short-description: Verify PawTalk trust boundaries
---

1. Read [SECURITY.md](../../../SECURITY.md) and
   [invariants](../../../agents/architecture/invariants.md); load only relevant
   docs/E2EE.md, docs/UPDATE-SIGNING.md or docs/RELEASING.md details.
2. Trace untrusted inputs to auth, IPC, filesystem/process and download boundaries.
   Preserve TLS pin-before-password, separate signing roots, digest/signature
   checks, bounded parsing and fail-closed behavior. The website catalog is not trust.
3. Verify rejection cases and applicable auth/signing/fault/lifecycle tests from
   [routing](../../../agents/testing/README.md); use synthetic secrets only.
4. Review staged data with check:public and manual diff; preserve AGPL/notices.
   No new production dependency without agreement; no public exploit report.
5. Report concrete risks, mitigations and verification limits; avoid unsupported
   security promises or leaking private data in handoff.
