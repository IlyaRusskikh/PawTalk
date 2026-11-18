# PawTalk Client 0.13.0 — Live chat, mentions and polls

[Русский](client-v0.13.0.ru.md) · [Canonical bilingual source](client-v0.13.0.md)

Preview for Windows x64; changes since Client 0.12.1.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.13.0/PawTalk.Setup.0.13.0.exe)

### Added

- A shared server-wide WebSocket delivers encrypted messages, edits and deletions directly to Client. State, unread counts and notifications share this stream; HTTP remains for commands, initial history, scrolling and gap recovery.
- Identity-bound @mentions with avatar suggestions and roster-to-composer drag and drop. Selected mentions use the theme accent, bypass server/channel mutes and retain a visible unread pin after an offline period. Matching plain text does not replace selecting a member.
- Polls with 2–10 options, single/multiple choices, anonymous voting and configurable interim results. Durations: 1, 4, 8 or 24 hours, 3 days, 1 or 2 weeks. Change or withdraw votes; authors can end polls early. Non-anonymous results show voter avatars with expandable overflow. A separate System reply publishes the result even with the author offline; completed polls and results cannot be deleted by users.
- Per-text-channel notification mutes with timed or manual expiry, clearer unread pins and gray muted server/channel counters. Windows alerts are grouped by chat, replace their predecessor and are cancelled after reading on this device, including their Action Center entry.
- Automatic Away presence after five minutes of system inactivity, including during calls, repeated in the user panel without a manual toggle. A linked profile stays online while any of its devices remains active.
- A shared server avatar editable by administrators, with square cropping and a circular safe-area guide.

### Fixed

- Microphone, deafen, device selection and voice disconnect are duplicated in the center of the call panel; lower user controls remain. Participant spacing and button geometry are corrected.
- Incoming device-link confirmation reopens above current work and restores window focus. Closing it rejects the request while preserving unrelated open forms. Confirmation does not display the link-input field.
- Remove an edited image using the hover trash control on its preview; saving without text or an image deletes the message. Server-avatar saving, avatar initials and poll-dialog clipping are corrected.
- Outgoing messages fly from the composer immediately in gray and regain normal color after server acknowledgment, without a second animation or moving older rows. Failures preserve the draft; retries reuse the request ID.
- History loads automatically without previous/next buttons. The 25–500-message preference (default 100) controls page size rather than cache capacity. Loaded blocks stay in RAM until leaving the chat or memory pressure; revisiting them and following replies reuse the cache. The lower-right down arrow shows new-message counts. Reading anchors and lazy image loading are preserved.

### Development

- Make commands start/stop isolated review Client, Manager and Server instances. Review Server keeps separate data without importing a version into installed Manager. Landing screenshots are refreshed in both languages.

### Install or update

Install Client 0.13.0. For new server-side features, upgrade permanent Server to 0.12.0 first using compatible Manager 0.5.1; this Server does not require a Manager upgrade. Client includes the same Server 0.12.0 core for temporary hosting. Older API 2 Servers remain usable with unsupported features hidden or HTTP fallback. Updating Client does not replace a separately installed Server. Back up Server before replacing it; restarting interrupts calls. API/data schema remain 2; API 1 is incompatible and has no automatic history/membership migration.

## Limitations

Preview. Alerts remain subject to sound settings, deafen and OS restrictions; read state is device-local. Anonymous votes are hidden from members, not the Server operator. No role-restricted channels, automatic key rotation or forward secrecy; previously retained keys/data cannot be revoked. History cache/DOM can grow while memory is available. Physical microphones, games/PTT, external networks and sustained load require separate acceptance. The EXE has no Authenticode signature; its Ed25519 update manifest does not replace a Windows publisher signature.

## Assets and source

PawTalk.Setup.0.13.0.exe · SHA256SUMS.txt · update-manifest.json · PawTalk.Licenses.0.13.0.zip

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.13.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.13.0/LICENSE)
