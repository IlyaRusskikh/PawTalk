# 007 — Committed encrypted envelopes over WebSocket

Status: implemented in development source; no release/publication is implied.

Context: invalidation-only events still caused one authenticated HTTP history read per receiver.

Decision: add opt-in message-events-v1 on a separate payload endpoint. Capture original encrypted envelopes and channel revisions once inside message-writing transactions, publish only after commit, and reuse encoded bytes across subscribers. Keep metadata-only routes for older clients. Reuse the existing client decoder and update chat/unread/mentions directly, with bounded reordering, duplicate handling and HTTP resync on gaps/overflow. Commands, initial/older history and attachments remain HTTP. Preserve subscriber authorization, TLS pinning and immutable E2EE context.

Consequences: no database schema change or production dependency. Failed transactions retain no live delivery. Individual ballot privacy and uncached quoted history remain HTTP; known quote context is reused. Redis is deferred: first measure remaining shared history reads after removing live fanout reads; do not cache personal permissions or counters across users. See architecture/connection-audit.en.md and its Russian counterpart.
