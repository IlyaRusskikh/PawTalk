# PawTalk Client 0.12.0 — Servers, channels and linked devices

[Русский](client-v0.12.0.ru.md) · [Exact historical release body](client-v0.12.0.md)

Historical **failed, unpublished release candidate**. This snapshot is not an available version.

## Changes and installation

### Added

- Multiple voice channels and text chats per server. Chat works without joining voice, and switching chats preserves the call. Administrators manage channels and the shared server name; the default General text and Main voice channels cannot be deleted.
- Persistent membership, a roster with presence and a You badge, compact voice participants, server hover previews and live drag-reorder previews. Overflow avatars become +N.
- Single-use 24-hour and reusable one-hour invitations, issued by administrators/moderators. Server-local device linking requires confirmation on both sides; control transfer, unlink and lost-device revocation are available. Linked devices share the group's profile/current rights, including message editing; only one device per group may join voice.
- Server departure, durable offline departure requests and confirmed shutdown when leaving your own Client-hosted server. Separate kick/ban notices show the server and available ban expiry.
- First-run setup, timed/indefinite server notification muting and Windows notifications with author and readable content. OS notification sound is disabled; formatting markers are removed and spoilers concealed.

### Fixed

- Replies resolve current originals and navigate to them, while preserving drafts, input focus, reading anchors and scrolling. Unread chats open at the unread divider; deleting the latest message does not create a phantom jump action.
- Corrected clipped badges/scrollbars, settings spacing, button styling, copy feedback and repeated control-transfer completion. Immediately visible messages in the active chat stay silent even during slow synchronization.
- Hosting diagnostics compare router WAN IPv4 with external IPv4 and explain possible mismatches.

### Changed

- E2EE is mandatory for text, voice and attachments. Initial setup creates the secret automatically; invitations carry an encrypted key package.
- Deafen also mutes the microphone; enabling either control after deafen restores both. Microphone-only mute leaves incoming sound enabled.

### Install or update

Install Client 0.12.0. Permanent hosting requires Server 0.11.0 and Manager 0.5.0; Client includes the updated selfhost core. API 1 is explicitly incompatible and has no automatic server history/membership migration. Create a fresh API 2 server and new invitations, retaining the old installation/backup separately for rollback. Restarting selfhost disconnects its participants. Device keys and secrets remain in OS-protected local storage.

## Full release record

The [immutable body snapshot](client-v0.12.0.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
