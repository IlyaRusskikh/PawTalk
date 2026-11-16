# PawTalk Client 0.11.0 — First-run setup, shared server core and responsive sounds

[Русский](client-v0.11.0.ru.md) · [Exact historical release body](client-v0.11.0.md)

This is a published preview release; it is not necessarily the latest compatible version.

## Changes and installation

### Added

- First-run language, nickname, avatar and microphone setup. Defer setup or resume it after restarting.
- New recordings of the project owner's cat Manya for messages and rooms, plus microphone/incoming-audio toggle cues.

### Fixed

- New messages start a cue immediately and fade the previous one over 120 ms. Room entry/exit cues are not dropped during message bursts; playback skips their quiet lead-ins.
- Hosting and network-check errors use the selected language without Electron's internal error wrapper. Retry clears the previous failure.
- Settings scrolling and update action layout; reopen an update offer from settings, including after a failed installation.

### Changed

- Temporary rooms build the same current `server/` core as permanent Windows Server. New builds no longer maintain the separate legacy pin/backport. Verification compares Go/LiveKit binaries byte for byte and checks receipt hashes.

### Install or update

Quit Client from its tray and install over the current version. Settings/bookmarks remain; new profiles receive the setup guide. Quitting the host closes its temporary room; share a new invitation after recreating it. Permanent Server 0.10.1 and Manager 0.2.1 require no upgrade for this Client. The new embedded core arrives with Client, not a separate Server update.

## Full release record

The [immutable body snapshot](client-v0.11.0.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
