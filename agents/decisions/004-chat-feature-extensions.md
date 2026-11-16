# 004 — Additive API 2 chat features

Status: implemented in development source; no release/publication is implied.

Context: shared Server must support away presence, shared avatars and expiring polls without receiving plaintext questions/options or requiring the author online at expiry.

Decision: retain API/data schema 2 and original tables; initialize separate idempotent feature tables only after identity validation. Advertise optional capabilities and use server-first upgrades. Keep Client/Server selfhost/serve on the shared core. Seal result templates in Client during atomic poll creation, reserve their request IDs, publish the exact bytes on a Server clock, and retrieve counts separately. Treat ballot selections and identities as operator-visible metadata; anonymous polls hide them only from participants. Keep mentions in encrypted content and scan unread pages client-side; keep mute/read preferences device-local.

Consequences: old API 2 Client displays poll question text without voting; old Server supports basic chat and rejects unsupported feature writes. No API 1 migration, key rotation or cryptographic ballot anonymity is claimed. Closed results are fixed; merging linked profiles coalesces only open ballots. Manager contracts/releases remain independent. See architecture/chat-features.en.md and its Russian counterpart for full limits.
