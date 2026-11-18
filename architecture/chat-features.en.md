# Development chat feature contracts

[Русский](chat-features.ru.md) · [Architecture](README.md)

These contracts describe development source, not already published binaries.

## Storage and compatibility

API/data schema stays 2. After validating the existing API 2 identity/schema, both hosting modes execute the additive, idempotent membership_features.sql DDL. Original tables, identifiers and key contexts remain unchanged. Separate tables hold session activity, server avatar, polls and ballots. Optional capabilities gate new writes; old API 2 peers retain ordinary chat. Manager remains host-only. API 1 is still rejected, with no migration.

## Presence, avatars and links

Electron powerMonitor supplies system idle time; 300 seconds is Away. Heartbeats publish it per live session. Any active live linked session makes the effective profile available; offline wins over idle. Renderer input cannot set a manual status. Server avatars use the existing avatar purpose with resource server-avatar and the publishing effective profile as authenticated encryption context. Admin role and expected avatar revision protect writes; malformed artwork cannot block chat.

Link contexts/private exchange keys remain in the main process after the code dialog closes. The renderer polls verified pending links; the main process restores/focuses once per incoming request. Confirmation overlays preserve other forms. Closing checks fresh link status and cancels with a signed device proof; only either participating device can cancel, and a cancelled request cannot finish.

## Mentions and notifications

Mentions are encrypted UTF-16 ranges bound to selected profile IDs. Edits shift untouched ranges and drop changed labels. The roster currently covers all channels because channel access is server-wide. Unread history is scanned in bounded pages, including after reconnect. Mention pins are separate from ordinary unread counts; mention alerts bypass server/channel mutes, but not deafen, configured sound suppression or OS restrictions. Read cursors and mute deadlines are device-local. No absolute OS delivery guarantee is claimed.

## Retained chat history

Chat history uses automatic boundary loading with a configurable 25–500-message request size, not a rolling eviction limit. Per-open-chat contiguous blocks retain loaded data in RAM; disjoint quote jumps preserve other blocks without rendering unknown gaps as loaded history. WS updates patch all cached blocks; legacy/resync reads refresh cached IDs in selections of at most 500. Leaving unmounts and clears this cache. Every 15 seconds, authorized local memory.status checks system available RAM (low below max(256 MiB, 5% of total)); the renderer also checks a supported JS heap signal (80% of its limit). Only pressure prunes distant blocks, retaining max(100, page size) messages around the viewport and preserving its anchor. No server polling or new dependency is added for this check. Decoded images retain their separate lazy lifecycle. This is not a claim about Discord's private cache eviction implementation; its public [message API](https://docs.discord.com/developers/resources/message#get-channel-messages) documents before/after pagination.

## Poll encryption and completion

Question/options are encrypted in the message; Server stores option count, duration, settings, voter profiles, selected indices and timestamps as metadata. Anonymous means hidden from participants, not from the operator; hidden interim results return no counts or identities even to the author. One effective profile has one replaceable/withdrawable ballot. Linking coalesces open ballots, choosing the latest; finished results stay unchanged.

Creation atomically reserves the original message and a separately sealed result template, with a stable request ID and replay hash. Result request IDs are reserved against ordinary sends. The result packet uses the original author/channel context and contains the poll reference/question/options, not guessed counts. A shared Server clock closes due polls every second and on startup, inserts the saved encrypted result bytes once, and exposes finalized counts via authenticated poll reads. This works without the author online; a stopped Server catches up after restart. Selfhost remains ephemeral. Authors can close early. Late votes and poll edits are rejected; result publication does not require an active author session. Server-owned result metadata displays the sender as System while preserving the original encryption context. Users cannot edit or delete results or delete completed polls; the server enforces this independently of the UI. Storage quotas/history deletion may remove original polls or results.

The result renderer links to the original poll; multiple-answer percentages use voters as the denominator and can sum above 100%. Ties show every highest option; zero votes has no winner.

## Event delivery

server-events-v1 adds one authenticated server-wide subscription and a small sequence checkpoint. It serves active chat, notifications, polls, roster/profile changes and admitted-device link attention. chat-events-v1 remains for older peers; unsupported/disconnected peers poll. The selected chat appends new rows and reuses quote/predecessor caches; edits/deletes and resync reload affected data. message-events-v1 additionally carries committed encrypted envelopes and deletion metadata at /api/v2/events/messages. Channel revisions detect duplicates and gaps; bounded queues fall back to HTTP on resync. Envelopes are captured once inside the writing transaction and serialized once for subscribers. No plaintext or root key reaches Server. Server access, E2EE and request/replay contracts remain unchanged. See [connection audit](connection-audit.en.md) for endpoints, resource bounds, retained heartbeats and verification limits.
