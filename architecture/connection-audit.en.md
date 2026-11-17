# Connection and polling audit

[Русский](connection-audit.ru.md) · [Architecture](README.md)

This describes development source audited on 2026-11-17, not installed releases.

| Connection / producer | Before | Decision and current behavior |
| --- | --- | --- |
| Client server state, channels, roster, profiles, voice roster | Full state every 3.5 s in renderer plus every 15 s in main | One main-process server-events-v1 WS per connected Server; typed state/chat invalidations, shared cached snapshots, coalesced reads. Full state only on actual state changes, connect/reconnect or explicit refresh. |
| Active chat / background unread, mentions, sound and Windows notifications | Active-channel WS plus global polling; unread mention history rescanned | Shared server stream; channel revision/last-ID metadata updates cached state without fetching the roster. Append/read only new history; edits/deletes, overflow and reconnect invalidate affected caches. One desktop batch per chat, mention priority, ID deduplication and grouped sound. |
| Poll results and ballots | Every open card read every 3.5 s | Read on mount/actions and matching WS invalidation. No card timer while stream is healthy; 3.5 s fallback when disconnected/unsupported. Completed cards stop polling. |
| Consistency / session liveness | Repeated full snapshots, HTTP heartbeat every 15 s | Authenticated sequence-only HTTP checkpoint no more than once per 30 s. WS ping/pong every 15 s updates session liveness; only solicited pongs do so. HTTP heartbeat remains when WS is unavailable. |
| Away status | Activity POST every 15 s | Publish on value/session change. Native idle observation remains local; no custom WS replaces OS APIs. |
| Linking on an admitted primary device | Global pending and dialog reads every 2 s | Matching server events invalidate cached pending status; healthy-stream recheck at 30 s, target dialog reacts to events. Local IPC pending checks are cheap. |
| New/unadmitted device linking | Temporary signed challenge/status reads every 2 s | Retained: admission has a different proof boundary and no membership session. Finite pending contexts only; not one background poll per ordinary member. |
| Voice lease | HTTP heartbeat every 15 s while joined | Retained: maintains a separate expiring voice grant; failure must disconnect voice even if ordinary chat still works. |
| LiveKit / WebRTC | Existing WS signaling, direct encrypted media, SDK events | Retained. Audio/RTP is not moved to the membership WS. Stats/ducking timers observe local SDK/audio state. |
| Chat sends/edits, images, admission proofs | Signed/authenticated HTTP and bounded uploads | Retained. Event delivery does not replace request IDs, retry semantics, E2EE, content bounds or streaming transfers. |
| Client/Manager updates | HTTPS metadata/download streams and timeouts; Manager periodic policy | Retained. GitHub/relay download trust, digests and signatures remain independent; download monitoring timers do not poll the room. |
| Manager desktop status | Every 1.5 s via local host executable/SCM and status file | Retained. Local process/OS observation, not per-member room HTTP polling; a WS would not detect stopped services by itself. |
| Manager watchdog/startup readiness | Windows health each minute, temporary readiness loops, system service/container checks | Retained as independent failure detection. No room membership socket is required for host administration. |
| NAT mapping, external reachability probes | Router lease renewals, bounded user-triggered tests | Retained. Router/probe protocols and ownership cleanup are separate from room event delivery. |

## Stream contract and limits

API/data schema stays 2. Optional server-events-v1 adds GET /api/v2/events and GET /api/v2/events/status; chat-events-v1 and its selected-channel endpoint remain for older peers. Events contain no message content or keys. Main retains bearer credentials; the existing bridge pins TLS before forwarding headers. Server rechecks membership before bounded batches and every 15 s. The client detects absent upstream traffic, reconnects with jitter/backoff, and reloads on reconnect. Old/disconnected peers retain polling.

Events coalesce per channel, with 64 pending keys per subscriber and a resync marker on overflow. Purpose-limited framing caps payloads at 2048 bytes and respects downstream backpressure. There are at most two subscriptions per device and 8192 total; these are resource guards, not tested capacity promises. A single server-side expiry check updates presence instead of one polling timer per subscriber. Anonymous/hidden poll identities remain protected by HTTP authorization.

A healthy idle client makes no repeated full-state or per-card poll request. Sequence checks, explicit commands, actual changes and independent voice leases still cause traffic. Full roster/profile snapshots remain a potential cost during large membership/profile changes; SQLite still uses a single connection. This change does not claim unlimited throughput.

## Verification boundary

The opt-in TestServerEventFanoutLoad seeds synthetic members, opens 100/500/1000 real local TCP WebSockets, publishes a shared event and performs an authenticated history read for each member. Run with PAWTALK_EVENT_LOAD=1 and go test -run TestServerEventFanoutLoad -v -count=1 inside server/. It excludes TLS overhead, E2EE decoding, external networks and audio. It demonstrates fanout behavior, not production sizing or sustained-load acceptance. Native Electron tests separately cover real pinned TLS, OS-protected credentials, reconnect/catchup, cached reads and audio integration. Docker/Linux and physical-device acceptance require their own environments.

Example final local run (milliseconds; timings vary):

| Members | WS event p95 | Event plus history read p95 | Maximum through history read |
| --- | ---: | ---: | ---: |
| 100 | 175 | 187 | 189 |
| 500 | 549 | 603 | 617 |
| 1000 | 980 | 1096 | 1128 |

These are one-batch local measurements, not a sustained-rate or hardware recommendation. Repeated runs on the same machine varied; serialized authentication/history work remains visible at 1000 members.
