# 006 — Shared server events instead of independent polling

Status: implemented in development source; no release/publication is implied.

Context: active-channel WS still left whole-state polling in two processes, per-card poll reads and repeated unread mention scans. A connected account needs events for background chats and membership/profile changes too.

Decision: advertise optional server-events-v1, share one pinned main-process socket per connected Server, publish bounded typed invalidations with monotonic sequence checkpoints, and retain the legacy channel stream and HTTP fallback. Use coalesced snapshot caches and incremental history reads. Keep HTTP mutations, admission proofs, transfers and independent voice leases. Tie session liveness to solicited ping/pong and detect stale transports. Batch desktop alerts with mention priority and deduplicate message IDs. Retain short-lived unadmitted-device proof polling and local host supervision.

Consequences: API/data schema and Manager trust contracts remain unchanged; no production dependency is added. Full roster/profile invalidations and serialized SQLite remain scaling costs. Opt-in local fanout tests do not prove external-network, media or sustained capacity. See architecture/connection-audit.en.md and its Russian counterpart for the complete inventory and limitations.
