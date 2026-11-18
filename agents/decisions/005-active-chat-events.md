# 005 — Active chat WebSocket invalidation

Status: implemented in development source; no release/publication is implied.

Context: polling the complete server state delays active chat updates. Selected-channel message edits, deletes and offline poll completion must appear promptly without weakening API 2 authentication or E2EE.

Decision: add optional chat-events-v1 and a bounded authenticated WebSocket invalidation endpoint in the shared Go core. Keep HTTP reads and client decryption authoritative. Reuse the main-process TLS-pinned signaling bridge for Node's built-in WebSocket, with a separate purpose-limited event path and frame limits. No new production dependency. Coalesce changes, revalidate access on each signal and periodically, reconnect with backoff, and reload on connect to cover gaps. Retain polling for old servers and broken transports.

Consequences: API/data schema and Manager contracts remain unchanged. Events contain no message data. Main owns tokens and socket lifecycle; only the selected chat subscribes. Server bounds subscriptions and closes revoked sessions. See architecture/chat-features.en.md and its Russian counterpart for limits.
