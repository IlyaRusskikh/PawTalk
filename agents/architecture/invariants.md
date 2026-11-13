# Architecture invariants

- Client and permanent Windows Server build the same server/ core and LiveKit
  through scripts/server-core.mjs with the same toolchain/flags; receipt hashes
  and scripts/check-server-core.mjs verify byte equality. selfhost and serve
  differ in lifetime/storage. Server release alone does not patch installed Client.
- API protocol 1 and capabilities, not release numbers, determine compatibility.
  Missing explicit protocol means legacy 1; unsupported explicit protocol fails
  before login. Follow docs/COMPATIBILITY.md and server-first transitions.
- TLS invitation fingerprint is checked before password transmission. Experimental
  E2EE is opt-in, has no automatic rotation or forward secrecy. Do not overclaim.
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
