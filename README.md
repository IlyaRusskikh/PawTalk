# Voicecord — self-hosted voice chat for Windows

[Русский](README.ru.md) · English

[![Build and tests](https://github.com/IlyaRusskikh/voicecord/actions/workflows/check.yml/badge.svg)](https://github.com/IlyaRusskikh/voicecord/actions/workflows/check.yml) · [AGPL-3.0-only](LICENSE)

Open-source voice chat for Windows 10/11 (x64), with self-hosted rooms for friends,
gaming groups and small communities. Create a room in the desktop app
or run a persistent server on your own Linux VPS. Join with an invitation, a shared
password and a nickname. No accounts, text chat or database.

**[Download Voicecord 0.1.0 for Windows x64](https://github.com/IlyaRusskikh/voicecord/releases/download/v0.1.0/Voicecord.Setup.0.1.0.exe)** ·
[Release notes and SHA-256 checksums](https://github.com/IlyaRusskikh/voicecord/releases/tag/v0.1.0) ·
[Linux server setup (Russian)](docs/SERVER.md) · [Report a bug](https://github.com/IlyaRusskikh/voicecord/issues/new/choose)

**0.1.0 is a public preview (pre-release).** The desktop interface is currently in Russian.
Real-device and external-network acceptance testing is still required; see
[acceptance criteria](docs/ACCEPTANCE.md) and [verification history](docs/VERIFICATION.md).

![Voicecord desktop home screen with options to join or create a room](website/assets/home.png)

Actual interface from current source, captured in an isolated test profile.
The download above is the published 0.1.0 preview.

<details>
<summary>Audio settings and room creation</summary>

![Voicecord microphone, speaker and voice activation settings with synthetic audio devices](website/assets/audio-settings.png)

![Room creation dialog with password, ports and optional E2EE](website/assets/create-room.png)

</details>

## Features

- Built-in temporary room server; guests need only the Windows client.
- Invitations with TLS certificate fingerprints and optional UPnP/NAT-PMP port mapping.
- Voice activation, push-to-talk, microphone monitoring, device selection and volume controls.
- Local RNNoise noise suppression, echo cancellation and automatic gain control.
- Global shortcuts, tray integration, mute/deafen and per-participant volume.
- Optional password storage protected by Electron/Windows safeStorage.
- Optional experimental end-to-end encryption; see [security model](docs/E2EE.md).
  Generate a VPS key from the home screen: «Настраиваете сервер?» →
  «Сгенерировать ключ шифрования» (Generate encryption key), or use a [script](docs/E2EE.md).
- Persistent Linux server with Docker Compose.

## Use the app

For a guided first conversation and troubleshooting, see
[First call on two PCs (Russian)](docs/FIRST-CALL.ru.md).

1. Download and install [Voicecord.Setup.0.1.0.exe](https://github.com/IlyaRusskikh/voicecord/releases/download/v0.1.0/Voicecord.Setup.0.1.0.exe)
   on each participant's Windows PC. No Node.js, Go or Docker is needed for the client.
2. Set your nickname in **«Настройки → Обо мне»** (Settings → About me).
3. Choose **«Создать комнату»** (Create room), enter a room name and a password
   of at least 8 characters.
4. Share the `voicecord://…` invitation privately. Guests paste the full invitation
   into the address field. For a LAN, use the LAN invitation.

The server runs while the host app remains running, including in the tray;
exiting or putting the host PC to sleep closes it. For a room that stays available
without the host PC, use a [persistent Linux server](docs/SERVER.md).

Built-in room invitations contain the room password and, when enabled, the E2EE
key. Share them privately; do not put live invitations in issues or source files.

Default incoming ports: TCP **18443**, TCP **18444**, UDP **18445**.
In Create room, choose **«Проверить»** next to **«Могу ли я хостить в интернет?»**
to check the selected ports via check-host.net. Green confirms TCP and UDP;
yellow means internet access was not confirmed, with checker errors shown separately.
Closing the dialog cancels the test and releases temporary mappings. The service
receives your public IP and ports; allow Voicecord through the firewall after creating a room.

Automatic port mapping does not guarantee internet access. CGNAT, double NAT and
network restrictions may require a VPS. For a LAN, share the LAN invitation.
Installers are currently unsigned and automatic updates are not configured.

## Check self-hosting before installing

Paste this into Windows PowerShell to fetch the script into memory, without
installing Voicecord or dependencies:

```powershell
$code = (Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/IlyaRusskikh/voicecord/main/scripts/check-selfhost.ps1').Content; & ([ScriptBlock]::Create($code))
```

The script temporarily listens on TCP/UDP ports and tries UPnP forwarding. Both
TCP ports and UDP are checked automatically via check-host.net with public reports;
no browser is needed. Manual 2ip checks remain a fallback.
The final verdict shows success, partial success or no confirmation.
On full success it finishes immediately, keeping results in the existing console.
For double-click launch, `scripts/check-selfhost.cmd` pauses before closing.
Actual voice operation is not verified.
See the [instructions](docs/SELFHOST-CHECK.md) for limitations and a full-script
copy/paste option without fetching code in the command. The command becomes available once the script is published to `main`.

## Is Voicecord right for you?

Voicecord is for people who want a small, account-free voice room they control.
If you are looking for a self-hosted alternative to Discord or TeamSpeak for
voice conversations, start with the preview and its limitations below. Voicecord
does not provide text channels, video, screen sharing or a public server directory.

| Situation | Setup |
| --- | --- |
| Talk on the same local network | Built-in room and LAN invitation |
| Host a temporary room over the internet | Built-in room with reachable incoming ports; NAT may need configuration |
| Keep a room available when your PC is off, or avoid hosting behind CGNAT | Linux VPS with Docker Compose and a public IP |

## Frequently asked questions

### Is Voicecord peer-to-peer (P2P)?

Voice uses WebRTC through a LiveKit media server. The server runs on the room
host's PC or your Linux VPS; this is a client-server design. Guests do not need
to deploy their own server.

### Can I use Linux, macOS, a phone or a web browser to join?

The released desktop client supports Windows 10/11 x64. Linux is supported as a
server platform (amd64/arm64). There is no released Linux, macOS, mobile or web
client; `dev:web` is a development UI preview.

### Is voice end-to-end encrypted?

E2EE is optional and experimental. Without E2EE, transport encryption does not
make the media server unable to access audio. Read the [E2EE security model](docs/E2EE.md)
before relying on it for sensitive conversations. Invitations can contain secrets.

### Why can my friends not connect?

Check the host's firewall and incoming TCP 18443, TCP 18444 and UDP 18445.
UPnP/NAT-PMP may not work behind CGNAT or double NAT. Use the LAN invitation on
the same network, or a reachable VPS for internet rooms. See the
[troubleshooting guide (Russian)](docs/GUIDE.ru.md) and [server network checks (Russian)](docs/SERVER.md).

### How do I update or get help?

Download the new installer from [Releases](https://github.com/IlyaRusskikh/voicecord/releases)
and read its release notes; updates are manual. Use
[GitHub Issues](https://github.com/IlyaRusskikh/voicecord/issues/new/choose) for bugs,
setup questions and feature requests. Include the app version and reproduction
steps, and remove invitations, passwords and personal network details.

## Build and change the source

On **Windows x64**, install:

- Node.js **24.22.1+** with npm;
- Go **1.27.3+** (or set `VOICECORD_GO` to its executable);
- Python **3.13** and Visual Studio Build Tools with **Desktop development with C++**
  and a Windows SDK.

Clone this repository using its GitHub **Code** button, or download and extract
the source ZIP. Open PowerShell in the project root:

```powershell
npm ci
npm run native:build
npm run dev
```

The first development launch builds the bundled API and downloads pinned LiveKit
Server 1.13.11 with checksum verification. Internet access and Windows `tar.exe`
are needed. Docker is not required for built-in rooms. Without the native module,
global push-to-talk and Windows audio ducking are unavailable.

Build a Windows installer with all local checks:

```powershell
.\build.cmd -InstallDependencies
```

Output: `release/Voicecord Setup 0.1.0.exe`. The script also supports an optional
LLVM toolchain; see the [detailed Russian guide](docs/GUIDE.ru.md).
`npm run dev:web` provides a browser UI preview; room connections use Electron IPC.

## Run a persistent server

Follow the **[step-by-step Linux deployment guide (Russian)](docs/SERVER.md)**:
administrator/container permissions, Docker installation links for major Linux
distributions, image download, IP/ports, startup and client connection. The VPS
needs only Docker Engine, the Compose file and `.env`; no source or Windows client.
One image tag includes **amd64 and arm64**; Docker selects the VPS architecture automatically.

After preparing both files in `/opt/voicecord`:

```sh
cd /opt/voicecord
docker compose -f compose.server.ghcr.yaml pull
docker compose -f compose.server.ghcr.yaml up -d --no-build
docker compose -f compose.server.ghcr.yaml logs server
docker compose -f compose.server.ghcr.yaml exec server /voicecord serve info
```

The first startup prints the generated password to the private server log.
Keep it and the invitation private. Open the three ports listed above. Server
data persists in a Docker volume. The public image
`ghcr.io/ilyarusskikh/voicecord-server:0.1.0` is published for Linux amd64 and arm64.
The guide also covers updates, network diagnostics and password changes.

## Verify changes

```powershell
npm run build
npm test
npm run check:public
Push-Location server
go test ./...
go vet ./...
Pop-Location
```

Windows UI check: `npm run smoke`. CI also builds the native module, checks the
Docker server and produces a Windows installer. Automated checks use synthetic
audio and do not replace tests on real microphones or across separate networks.

## Documentation and contribution

- [Detailed setup and troubleshooting (Russian)](docs/GUIDE.ru.md)
- [First call on two PCs (Russian)](docs/FIRST-CALL.ru.md)
- [Server deployment](docs/SERVER.md), [API](docs/API.md), [E2EE](docs/E2EE.md)
- [Contributing / Участие в разработке](CONTRIBUTING.md)
- [Versions and releases / Версии и релизы](docs/RELEASING.md)
- [Changelog](CHANGELOG.md)
- [Project discoverability checklist for maintainers (Russian)](docs/DISCOVERABILITY.ru.md)
- [Project website source and Pages publishing](website/README.md)
- [Post-release repository review and remaining checks (Russian)](docs/REPOSITORY-REVIEW.ru.md)
- [Historical pre-publication checks (Russian)](docs/PUBLICATION-REVIEW.ru.md)

## License

Voicecord's original code is licensed under **GNU AGPL v3.0 only**
(`AGPL-3.0-only`); see [LICENSE](LICENSE). Copyright © 2026 Voicecord contributors.
You may use, modify and redistribute it under those terms. Distributed modified
versions must provide corresponding source under AGPL; modified versions used
over a network must offer their corresponding source to remote users.
Third-party components retain their own licenses; see [notices](THIRD_PARTY_NOTICES.md).
