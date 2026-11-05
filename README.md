# Voicecord

[Русский](README.ru.md) · English

Self-hosted voice rooms for Windows 10/11 (x64). Create a room in the desktop app
or run a persistent server on your own Linux VPS. Join with an invitation, a shared
password and a nickname. No accounts, text chat or database.

**Version: 0.1.0 — early release.** The desktop interface is currently in Russian.
Real-device and external-network acceptance testing is still required; see
[acceptance criteria](docs/ACCEPTANCE.md) and [verification history](docs/VERIFICATION.md).

## Features

- Built-in temporary room server; guests need only the Windows client.
- Invitations with TLS certificate fingerprints and optional UPnP/NAT-PMP port mapping.
- Voice activation, push-to-talk, microphone monitoring, device selection and volume controls.
- Local RNNoise noise suppression, echo cancellation and automatic gain control.
- Global shortcuts, tray integration, mute/deafen and per-participant volume.
- Optional password storage protected by Electron/Windows safeStorage.
- Optional experimental end-to-end encryption; see [security model](docs/E2EE.md).
- Persistent Linux server with Docker Compose.

## Use the app

Download `Voicecord Setup <version>.exe` from this repository's **Releases**, when
a Windows build has been published. Install it and choose **«Создать комнату»**
(Create room), enter a room name and a password of at least 8 characters, and share
the `voicecord://…` invitation and password privately. Guests paste the full
invitation into the address field. The server runs while the host app remains
running, including in the tray; exiting or putting the host PC to sleep closes it.

Built-in room invitations contain the room password and, when enabled, the E2EE
key. Share them privately; do not put live invitations in issues or source files.
Set your nickname in **«Настройки → Обо мне»** (Settings → About me).

Default incoming ports: TCP **18443**, TCP **18444**, UDP **18445**.
Automatic port mapping does not guarantee internet access. CGNAT, double NAT and
network restrictions may require a VPS. For a LAN, share the LAN invitation.
Installers are currently unsigned and automatic updates are not configured.

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
data persists in a Docker volume. The image `ghcr.io/ilyarusskikh/voicecord-server:0.1.0`
becomes available after the first release tag is published and the GHCR package is
made public. The guide also covers that one-time setup, updates and password changes.

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
- [Server deployment](docs/SERVER.md), [API](docs/API.md), [E2EE](docs/E2EE.md)
- [Contributing / Участие в разработке](CONTRIBUTING.md)
- [Versions and releases / Версии и релизы](docs/RELEASING.md)
- [First GitHub publication / Первая публикация](docs/PUBLISHING.ru.md)
- [Publication checks and limitations (Russian)](docs/PUBLICATION-REVIEW.ru.md)
- [Changelog](CHANGELOG.md)

## License

Voicecord's original code is licensed under **GNU AGPL v3.0 only**
(`AGPL-3.0-only`); see [LICENSE](LICENSE). Copyright © 2026 Voicecord contributors.
You may use, modify and redistribute it under those terms. Distributed modified
versions must provide corresponding source under AGPL; modified versions used
over a network must offer their corresponding source to remote users.
Third-party components retain their own licenses; see [notices](THIRD_PARTY_NOTICES.md).
