# Development chat feature contracts

[Русский](chat-features.ru.md) · [Architecture](README.md)

These contracts describe development source, not already published binaries.

## Storage and compatibility

API/data schema stays 2. After validating the existing API 2 identity/schema, both hosting modes execute the additive, idempotent membership_features.sql DDL. Identifiers and key contexts remain unchanged; media support expands the attachment size constraint as described below. Separate tables hold session activity, server avatar, polls and ballots. Optional capabilities gate new writes; old API 2 peers retain ordinary chat. Manager remains host-only. API 1 is still rejected, with no migration.

## Presence, avatars and links

Electron powerMonitor supplies system idle time; 300 seconds is Away. Heartbeats publish it per live session. Any active live linked session makes the effective profile available; offline wins over idle. Renderer input cannot set a manual status. Server avatars use the existing avatar purpose with resource server-avatar and the publishing effective profile as authenticated encryption context. Admin role and expected avatar revision protect writes; malformed artwork cannot block chat.

Link contexts/private exchange keys remain in the main process after the code dialog closes. The renderer polls verified pending links; the main process restores/focuses once per incoming request. Confirmation overlays preserve other forms. Closing checks fresh link status and cancels with a signed device proof; only either participating device can cancel, and a cancelled request cannot finish.

## Mentions and notifications

Mentions are encrypted UTF-16 ranges bound to selected profile IDs. Edits shift untouched ranges and drop changed labels. The roster currently covers all channels because channel access is server-wide. Unread history is scanned in bounded pages, including after reconnect. Mention pins are separate from ordinary unread counts; mention alerts bypass apps/server/channel mutes, but not deafen, configured sound suppression or OS restrictions. Read cursors and mute deadlines are device-local. No absolute OS delivery guarantee is claimed.

## Retained chat history

Chat history uses automatic boundary loading with a configurable 25–500-message request size, not a rolling eviction limit. Per-open-chat contiguous blocks retain loaded data in RAM; disjoint quote jumps preserve other blocks without rendering unknown gaps as loaded history. WS updates patch all cached blocks; legacy/resync reads refresh cached IDs in selections of at most 500. Leaving unmounts and clears this cache. Every 15 seconds, authorized local memory.status checks system available RAM (low below max(256 MiB, 5% of total)); the renderer also checks a supported JS heap signal (80% of its limit). Only pressure prunes distant blocks, retaining max(100, page size) messages around the viewport and preserving its anchor. No server polling or new dependency is added for this check. Decoded images retain their separate lazy lifecycle. This is not a claim about Discord's private cache eviction implementation; its public [message API](https://docs.discord.com/developers/resources/message#get-channel-messages) documents before/after pagination.

## Poll encryption and completion

Question/options are encrypted in the message; Server stores option count, duration, settings, voter profiles, selected indices and timestamps as metadata. Anonymous means hidden from participants, not from the operator; hidden interim results return no counts or identities even to the author. One effective profile has one replaceable/withdrawable ballot. Linking coalesces open ballots, choosing the latest; finished results stay unchanged.

Creation atomically reserves the original message and a separately sealed result template, with a stable request ID and replay hash. Result request IDs are reserved against ordinary sends. The result packet uses the original author/channel context and contains the poll reference/question/options, not guessed counts. A shared Server clock closes due polls every second and on startup, inserts the saved encrypted result bytes once, and exposes finalized counts via authenticated poll reads. This works without the author online; a stopped Server catches up after restart. Selfhost remains ephemeral. Authors can close early. Late votes and poll edits are rejected; result publication does not require an active author session. Server-owned result metadata displays the sender as System while preserving the original encryption context. Users cannot edit or delete results or delete completed polls; the server enforces this independently of the UI. Storage quotas/history deletion may remove original polls or results.

The result renderer links to the original poll; multiple-answer percentages use voters as the denominator and can sum above 100%. Ties show every highest option; zero votes has no winner.

## Event delivery

server-events-v1 adds one authenticated server-wide subscription and a small sequence checkpoint. It serves active chat, notifications, polls, roster/profile changes and admitted-device link attention. chat-events-v1 remains for older peers; unsupported/disconnected peers poll. The selected chat appends new rows and reuses quote/predecessor caches; edits/deletes and resync reload affected data. message-events-v1 additionally carries committed encrypted envelopes and deletion metadata at /api/v2/events/messages. Channel revisions detect duplicates and gaps; bounded queues fall back to HTTP on resync. Envelopes are captured once inside the writing transaction and serialized once for subscribers. No plaintext or root key reaches Server. Server access, E2EE and request/replay contracts remain unchanged. See [connection audit](connection-audit.en.md) for endpoints, resource bounds, retained heartbeats and verification limits.

## Media and checklists

media-files-v1 raises encrypted attachment plaintext to 50 MiB (ciphertext plus 16 bytes). JSON transport is bounded at 70 MiB and attachment requests have a 120-second Client timeout. Startup transactionally expands the legacy attachment table constraint, copies encrypted bytes unchanged, and recreates indexes and ownership triggers; API/data version remains 2. Image uploads retain 2 MiB and signature inspection. Documents use application/octet-stream and download links, never HTML rendering or transcoding. Filenames and MIME metadata remain inside encrypted message content.

checklists-v1 adds checklists keyed to messages with cascade deletion. Title/item text stays encrypted; Server sees opaque item IDs, check states and the everyone/author policy. Only the resolved author may edit message content; chat.write members may check known item IDs when policy permits. Mutation receipts protect retries. Editing preserves checks for retained IDs and removes obsolete IDs. checklist-events-v1 carries check snapshots inside committed chat envelopes. A check advances the channel revision without rewriting encrypted content. Clients reject stale snapshots; state reads recover on reconnect/resync. Older Servers and disconnected streams retain polling. Manager APIs are unchanged.


`media-gallery-v1` permits up to twenty unique attachment IDs per message (ten files and up to ten poster images). New encrypted content carries `files` or a single legacy `file` with an optional `poster` reference and duration; original single-image/file messages remain readable. Send retries compare the complete attachment-ID set, independent of order. Binding remains atomic, with existing ownership/channel/device checks, quotas and cascade deletion. Pending uploads are bounded to twenty per device and expire after thirty minutes, allowing sequential multi-video uploads. Posters use the existing bounded image upload/encryption path; plaintext frames and filenames never enter Server metadata. No numeric API/data migration or Manager contract changes are needed. Older Clients cannot display the new gallery field and must update to view multi-file messages.

### Media variants

With `media-variants-v1` on API 2 or `protectedMediaVariants` on API 3, the sending Client prepares media before encryption. For photos, GIFs and playable MP4/WebM video it attempts a static WebP preview with a 480 px long edge and an 80 KiB cap. Video previews use a frame near the beginning. The original file is uploaded byte-for-byte. The chat gallery fetches only a stored preview near the viewport, with at most two image requests in progress, and releases preview URLs when cards leave that range. Cards without a preview remain openable. Legacy single-image messages retain their original viewer.

For a static photo of at least 1 MiB with a long edge above 2048 px, Client tries a WebP viewing copy at a 2048 px long edge. It uploads that copy when it saves at least half the bytes and the message has a free attachment slot after reserving originals and previews. The viewer fetches the viewing copy on open and otherwise uses the original. **Download original** always targets the original attachment. Video and GIF playback use the original, including the original animation.

Each variant has a unique attachment ID. The encrypted manifest stores photo and GIF derivatives as `preview` or `view` with their MIME type and byte length. Video keeps the existing `poster` reference, and an API 2 single photo keeps its `image` entry and attachment removal action. Server binds the complete set to the same message under existing access, expiry and deletion rules. API 3 also binds the ordered references to the signed packet and uses separately sealed attachments. Messages remain limited to ten user files and twenty stored objects. Unsupported servers retain the legacy send format. See [the decision and measurement basis](../agents/decisions/014-media-variants.en.md).

New photo and GIF `preview` entries also include the encoded WebP width and height in the encrypted manifest. The client uses those optional pixel dimensions to reserve space before fetching the preview. Older entries use the existing placeholder and adopt the decoded dimensions when the preview loads.
