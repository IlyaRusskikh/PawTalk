# Architecture invariants

- Client and permanent Windows Server build the same server/ core and LiveKit
  through scripts/server-core.mjs with the same toolchain/flags; receipt hashes
  and scripts/check-server-core.mjs verify byte equality. selfhost and serve
  differ in lifetime/storage. Server release alone does not patch installed Client.
- API protocol 2 and capabilities, not release numbers, determine compatibility.
  Missing/legacy/unknown protocol is rejected before identity or admission proofs.
  API 1 has no production fallback or data migration. Follow docs/server/compatibility.en.md.
- TLS invitation fingerprint is checked before HTTP credentials. E2EE is mandatory:
  clients create/retain the server root and derive channel/purpose keys; the host
  stores opaque packages only. No automatic rotation or forward secrecy is promised.
- Membership, voice presence and server-local device bindings are independent.
  Every authenticated action checks current membership/role/ban. Original message
  authors remain immutable. Unlink ends inherited edit/admin rights immediately.
- Updaters keep independent Client/Server/Manager Ed25519 trust roots, signed
  repository/component/channel/version/digest contracts. The public website catalog
  does not authorize executable updates or replace signature verification.
- Manager runs on the host, not a privileged server container. Config, managed
  state/journal and room data remain separate. One lock protects transactional
  backup/update/restore and watchdog operations. Recovery restores data+image,
  preserving identity; no image-only rollback. Unchanged runtime need not restart voice.
- No duplicate production implementations or dependencies without owner agreement.
  Record substantial decisions in agents/decisions/ with context, alternatives,
  consequences and verification; preserve historical published contracts.
