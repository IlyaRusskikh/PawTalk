# PawTalk — self-hosted voice chat for gaming and friends

[Русский](README.ru.md) · English

Released: **Client 0.11.0 / Server 0.10.1 / Manager 0.3.0**. The `v0.8.1` bridge enables installed 0.8.0 clients to discover `client-v*` releases. Permanent Linux and Windows servers use independent signed updates. [Release process](docs/RELEASING.md) · [Compatibility](docs/COMPATIBILITY.md).

Client 0.11.0 adds first-run setup, responsive notification sounds and a shared embedded server core. [Client release notes](docs/releases/client-v0.11.0.md).

Manager **0.3.0 preview is released**: an Electron/React settings window, live status colors in the tray, access/backup/diagnostic actions and automatic Windows Manager installation with signature and hash checks. [New Manager behavior and verification](docs/MANAGER-DESKTOP.md).

[Release notes and upgrade order](docs/RELEASE-NOTES-0.10.1.md). Windows Server Manager adds tray controls, settings, ProgramData migration and optional full-data removal. Upgrade the installed Server to 0.10.1 for activity privacy; reinstalling Manager preserves the installed Server version.

[![Verify and package](https://github.com/IlyaRusskikh/PawTalk/actions/workflows/check.yml/badge.svg)](https://github.com/IlyaRusskikh/PawTalk/actions/workflows/check.yml)

PawTalk is an **alternative to Discord and TeamSpeak for voice chat** on Windows. Get friends together before a match, talk to your team while you play, or give your community a room it can come back to. Join with an invitation and a nickname. No account required.

**[Download PawTalk 0.11.0 for Windows 10/11 (x64)](https://github.com/IlyaRusskikh/pawtalk/releases/download/client-v0.11.0/PawTalk.Setup.0.11.0.exe)** · [Get started](#get-started) · [Linux server](docs/SERVER.md) · [Windows server installer](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.3.0/PawTalk.Server.Manager.Setup.0.3.0.exe)

![PawTalk room with three participants, call controls and encrypted text chat](website/assets/room-chat-en.png)

## What you can do with PawTalk

- **Get friends together for a game night.** Start a room on your PC and send an invitation. The room stays available while PawTalk runs, including in the system tray.
- **Talk on your local network.** Share a LAN invitation when everyone is on the same network, whether you're at a LAN party or playing at home.
- **Give your team a permanent room.** The server runs independently of the PawTalk app: Docker Compose on Linux or native services on Windows. The server computer stays on; the owner's PawTalk client can be closed. [Server guide](docs/SERVER.md).

## Feature comparison

| Feature | PawTalk | Discord | TeamSpeak |
| --- | :---: | :---: | :---: |
| Advanced noise suppression | ✅ | ✅ | ❌ |
| Suppression of a nearby participant's voice | ✅ | ❌ | ❌ |
| Modern interface | ✅ | ✅ | ❌ |
| Host the server on your own hardware | ✅ | ❌ | ✅ |
| Open-source client and server | ✅ | ❌ | ❌ |

## Familiar voice controls, your own server

PawTalk takes inspiration from **Discord** for easy-to-join voice rooms and individual volume controls, and from **TeamSpeak** for hosting your own server and deciding who can join. It brings these ideas together in an open-source app with invitation-based access.

- **Set up audio the way you like it.** Choose your microphone and headphones, listen to a mic test, and adjust each person's volume separately.
- **Talk when you speak or hold a key.** Choose voice activation or Push-to-Talk. Use global shortcuts for microphone mute and incoming audio while your game is open.
- **Manage your call.** Use the controls above the chat divider to mute, switch audio devices, or leave. Hover over an avatar to reveal the participant’s name and signal icon. Hover over the signal icon to see the current ping. Click it to open a connection summary with outgoing audio packet loss to the LiveKit server, reported by the receiver through RTCP; clicking outside closes it. On your own card, choose Debug to view Transport and Outbound statistics with two-minute charts. History stays on your device and resets when you leave the room.
- **Set a profile picture.** Under **Settings → About me**, choose a PNG, JPEG, or WebP. Zoom and position the image in the circular preview. Participants see your current nickname and avatar in the room and in retained chat history.
- **Make speech easier to hear.** RNNoise reduces background noise on your PC, echo cancellation reduces echo, and automatic gain control evens out the level of your voice.
- **Return to your favorite rooms.** Bookmark a server so you can find it again quickly. Your current unsaved voice room appears in the sidebar with a stopwatch badge; hover over it and click the star to save the room. Reply previews preserve message formatting.
- **Send messages during a call.** The room opens with chat below the participant cards. Press Enter to send or Shift+Enter for a new line. You can send up to three messages per second and see when someone else is typing. Drag the divider to resize either section. Built-in E2EE rooms keep history in memory until the server stops. VPS history uses a configurable storage budget with no age limit (see Project status).
- **Get started.** On first launch, a three-step guide helps you choose a language and nickname, add an avatar, and test audio devices. You can go back or set up later. Available updates open above Settings; use **Open update** to return to a deferred offer.
- **Hear the room.** Notification recordings feature Manya, the project owner’s cat, recorded on a phone and distributed under the project’s AGPL-3.0-only license. Microphone and incoming audio toggles also play a cue. Cat meows mark joining and leaving. Five soft purr variations announce new messages in the current room when the app is inactive or the chat is scrolled up. Your own messages and loaded history stay silent. A new message cue starts immediately and fades the previous one out over 120 ms. Room entry/exit cues remain available during message bursts and skip the recordings’ quiet lead-in. Sounds use your selected output device and volume; disable them under **Settings → Audio and devices → Sounds**.

<details>
<summary>See audio settings and room creation</summary>

![PawTalk audio settings for microphone, speakers and voice activation](website/assets/audio-settings-en.png)

![PawTalk room creation form with room name and password](website/assets/create-room-en.png)

</details>

## Get started

1. **Install PawTalk.** [Download the installer](https://github.com/IlyaRusskikh/pawtalk/releases/download/client-v0.11.0/PawTalk.Setup.0.11.0.exe) on each Windows PC. Choose English or Russian.
2. **Pick a nickname.** Open **Settings → About me** and enter a nickname. You can test your microphone under **Voice**.
3. **Get your friends together.** Select **Create a room**, give the room a name, and choose a password of at least 8 characters. Share the full invitation privately. Your friend opens **Join a room** and pastes the link.

Already have an invitation? Open **Join a room** after installing. [First call on two PCs (Russian)](docs/FIRST-CALL.ru.md).

## Questions and setup

<details>
<summary>How do I invite a friend?</summary>

In the room creation dialog, choose **Check** next to **Can I host over the internet?**. Internet hosting uses incoming TCP 18443, TCP 18444, and UDP 18445 by default. If your router or ISP restricts inbound connections, you can host on a Linux VPS with a public IP. A permanent Windows server uses the separate Server Manager installer; temporary rooms inside the Windows app remain available.
To check whether you can self-host, copy this command into **Windows PowerShell**:

```powershell
$code = (Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/IlyaRusskikh/pawtalk/main/scripts/check-selfhost.ps1').Content; & ([ScriptBlock]::Create($code))
```

[How the check works (Russian)](docs/SELFHOST-CHECK.md) · [Linux server setup (Russian)](docs/SERVER.md).

</details>

<details>
<summary>Which devices can run PawTalk?</summary>

The desktop client runs on Windows 10/11 x64. The persistent server uses Docker Compose on Debian 12 / Ubuntu 24.04 amd64/arm64, or native services on Windows x64. See the [Windows setup and verification limits](docs/WINDOWS-SERVER.md). Voice travels through a LiveKit media server over WebRTC. [Server guide](docs/SERVER.md).

</details>

<details>
<summary>Is PawTalk safe to use?</summary>

PawTalk protects the connection to the server with TLS and checks the certificate fingerprint from the invitation. Voice is encrypted in transit over WebRTC. However, **without E2EE, the server operator can access voice and stored chat**: choose a server you trust.

You can enable **experimental end-to-end encryption (E2EE)** for voice and chat. It is off by default; participants receive the shared key through the invitation. The server can still see IP addresses, the participant list, and traffic timing and volume. Automatic key rotation and forward secrecy are not available yet. A built-in room invitation contains the password and, with E2EE enabled, the secret key: share it privately and do not publish it.

PawTalk is still a public preview. Updates are verified using a signed manifest and SHA-256, but the Windows installer is not yet Authenticode-signed. [E2EE security model and setup](docs/E2EE.md) · [Security policy and vulnerability reporting](SECURITY.md).

For the Server Manager installer, the key generator shows a shared participant secret and a separate SHA-256 key ID to paste into the wizard, without `.env` entries. On Windows, `scripts\e2ee-key.cmd` runs without installing PawTalk or Node.js. The VPS wizard defaults to enabling encryption and automatic updates; one update question covers both the server and its maintenance tool. VPS updates select the latest published version for each component tag family, with no channel setting.

</details>

<details>
<summary>How do I update or get help?</summary>

The available-update button appears in the sidebar above Settings without shifting the page.

Current PawTalk builds check GitHub releases at startup and verify the update manifest signature and the file's SHA-256 checksum before installing. If GitHub is unavailable, the updater can use a compatible bookmarked room as a download relay. Both built-in Windows self-host rooms and VPS rooms support this; the room must be running and able to reach GitHub for metadata and uncached files. The server streams and caches one installer on disk, serves repeat downloads without fetching the installer from GitHub again, and removes the older cached installer after a newer version finishes downloading. Installer transfers have no server bandwidth cap.

[Update details](docs/UPDATES.md).
For setup or connection issues, see the [troubleshooting guide (Russian)](docs/GUIDE.ru.md). Ask questions or suggest changes in [GitHub Issues](https://github.com/IlyaRusskikh/pawtalk/issues/new/choose). Include your version and steps to reproduce the issue. Remove live invitations, passwords, keys, and personal network details.

</details>

Server Manager setup downloads signed releases from GitHub. Temporary connection resets, timeouts and incomplete downloads are retried up to three attempts. If setup still fails with a download error (including Windows error 10054), check access to `api.github.com`, `github.com` and `release-assets.githubusercontent.com` through your network/VPN, then run setup again.

**Manager 0.4.0 is in preparation.** It opens on the first tray double-click or Settings command, fixes settings loading, removes the installer invitation page, and keeps network update checks from blocking backups or diagnostics. Manager and Server have separate check/install actions. Backups can be deleted from the UI after confirmation. **Updates → Server → Install from file…** accepts a Windows Server ZIP or portable package, with signature status, explicit approval and rollback. See [local packages](docs/MANAGER-DESKTOP.md#local-server-packages--локальные-пакеты-server).

On Windows, Server Manager installs a separate **PawTalk Server** tray icon with a small server badge in the upper-right corner. Right-click it to start or stop the server. **Stop server and exit** stops the server and closes the icon; **Close tray** keeps the Windows service running. The installer offers desktop and sign-in startup shortcuts; the Start menu shortcut is always installed. Starting or stopping the service may request administrator approval.

**Server settings…** in the tray opens a window with the current IPv4 address, port, E2EE/key ID, history limit, Server/Manager automatic updates and language. Applying runtime changes creates a backup, restarts the room and checks its health; failures restore the previous configuration/data. Changing IP or port requires a new invitation and updated forwarding/firewall rules; IP changes require the updated Server with `serve rebind` support. A window opened before another configuration change must be reopened before saving.

In the development build, Windows Manager copies the password-bearing invitation (`#password=…`) from **Overview**, and the installer does not display credentials. Overview can also explicitly reset a forgotten password; resetting interrupts active calls and invalidates old password-bearing invitations. A local copy is protected with Windows DPAPI and the private data-root permissions. Older installations without a saved password require a reset. If E2EE is enabled, the client asks for the shared secret separately; the installer’s key ID is not that secret. The client also separates the old Manager’s two unlabelled lines when pasted together.

The Windows program is installed in `%ProgramData%\PawTalk Server Manager`, with room settings, history and backups in `%ProgramData%\PawTalk`. It remains a service that runs before user sign-in. Reinstallation reuses an existing config and skips the settings form; it preserves the room identity. The EXE uninstaller always removes program files and services. Its **Delete settings and data** checkbox is off by default; enabling it also removes the room, keys, history and backups. For scripted full removal, use `Uninstall.exe /S /DELETE-DATA`. The Manager installer and uninstaller use the server badge too. LAN clients use the authenticated server’s `/rtc` proxy even if a published standalone server advertises its public IP.

## For developers

The next Server build requires current room authorization for occupancy and participant previews, including aggregate counts. Password reset revokes old preview/chat tokens and rotates the voice signing secret on restart. The updated Client never falls back to an anonymous count after access is denied; it shows **Sign in again**. Bookmarks identify the verified room independently of its password, so sharing a link or entering a new password updates one bookmark after successful login. The server-side protection requires updating Server as well as Client; it does not change an already installed published binary.

Client 0.11.0 and development builds use one shared `server/` core for temporary Client rooms and permanent Windows/Linux servers. Both Windows packages use the same compiler and flags; CI compares their Go and LiveKit binaries byte for byte. The embedded receipt records the source and binary hashes. Historical Client 0.10.1 retains its legacy pinned core. [Build and compatibility details](docs/BUNDLED-SERVER.md).

<details>
<summary>Build and run checks on Windows x64</summary>

Install Node.js **24.22.1+** with npm, Go **1.27.3+**, Python **3.13**, and Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK. You can set the Go executable with `PAWTALK_GO`.

```powershell
npm ci
npm run native:build
npm run dev
```

Run `.\build.cmd -InstallDependencies` to build a Windows installer. The first development launch builds the bundled API and downloads LiveKit with checksum verification. [Build guide (Russian)](docs/GUIDE.ru.md).

Branch and PR checks cover all components. Release tags build and upload their own packages: Client EXE, Server ZIP/image, or Manager EXE/bundle. Compatibility tests can use a published signed Server or prepare a minimal test host. Manual verification offers `all`, `client`, `server`, and `manager` scopes and does not publish.

Use `npm run build`, `npm test`, `npm run smoke`, and `npm run check:public` when changing the client. Run `go test ./...` and `go vet ./...` in `server` for server changes. [GitHub Actions](https://github.com/IlyaRusskikh/pawtalk/actions/workflows/check.yml).

</details>

[Documentation index](docs/README.md) · [Development and local Docker](docs/DEVELOPMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [API](docs/API.md) · [Release process](docs/RELEASING.md)

PawTalk is licensed under [GNU AGPL-3.0-only](LICENSE). Third-party components retain their own licenses. [Third-party notices](THIRD_PARTY_NOTICES.md).

The [server configuration guide](docs/SERVER.md#конфигурация) covers allowed values, storage budgets, independent updates and applying changes.

## Project status

**Current public preview: [PawTalk Client 0.11.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.11.0)**. [Server 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1) and [Manager 0.3.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.3.0) are released separately. This is not a stable release.

### Available in 0.11.0

- Voice rooms with invitations, nickname-only entry, Push-to-Talk, per-user volume, RNNoise noise suppression and audio device selection.
- Text chat with replies, Markdown, editing/deleting your own messages on updated servers, typing indicators, room previews, unread counts and static PNG/JPEG/WebP attachments up to 2 MiB.
- Profiles and avatars, bookmarked rooms, light/dark/custom themes and Russian/English interfaces.
- Notification sounds for joining, leaving and messages; adjustable shared notification volume and previews.
- Optional experimental E2EE for voice and chat; the secret key is shared with participants via the invitation. [Security model](docs/E2EE.md).
- Host a temporary room in the Windows app or a permanent Linux/Windows server with Server Manager. Persistent chat storage defaults to 128 MiB and evicts the oldest content when full. [Linux](docs/SERVER.md) · [Windows](docs/WINDOWS-SERVER.md).
- Password-bearing invitations, missing E2EE-key prompts and deduplicated verified-room bookmarks. Updated servers require current access for activity previews and revoke old tokens after a native password reset.
- Update checks and downloads with signed manifests, SHA-256 verification and fallback relays through compatible bookmarked rooms. [Update details](docs/UPDATES.md).

### Important limitations

- The Windows installer is **not Authenticode-signed**. Release assets include SHA-256 checksums; they do not replace an OS publisher signature.
- Hardware acceptance remains outstanding for real microphones, games/global PTT and UAC, external-network calls, packet loss, and large groups. Automated tests use synthetic devices where indicated. [Acceptance checklist](docs/ACCEPTANCE.md) · [Verification history](docs/VERIFICATION.md).
- E2EE is **off by default and experimental**. Without it the media server can access voice, and the server can read stored chat content. E2EE currently has no automatic key rotation or forward secrecy. Share complete invitations privately. [Details](docs/E2EE.md).
See the [changelog](CHANGELOG.md) for previous versions, [settings reference](docs/SETTINGS.md) for all controls, and [security policy](SECURITY.md) for reporting vulnerabilities.
