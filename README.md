# PawTalk — self-hosted voice and text chat

[Русский](README.ru.md) · [Documentation](docs/README.md) · [Security](SECURITY.md)

PawTalk is an AGPL-3.0-only Windows app for friends and gaming communities.
Host a temporary server from the client or run a permanent Windows/Linux server.
No central account is required.

**Published API 2:** multichannel servers use mandatory E2EE and a fresh data schema.
There is no automatic migration of API 1 installations. Choose compatible components
from GitHub Releases; see [compatibility](docs/COMPATIBILITY.md).

## Downloads

- [Windows Client](https://ilyarusskikh.github.io/PawTalk/downloads/#client)
- [Permanent Server](https://ilyarusskikh.github.io/PawTalk/downloads/#server)
- [Server Manager](https://ilyarusskikh.github.io/PawTalk/downloads/#manager)

Components have independent releases and updates. Updating Client or Manager does
not replace an installed Server. Public versions and downloads come from GitHub
Releases; source package versions do not announce a release.

## API 2 features

- Multiple voice channels and text chats. Administrators create, rename and delete
  channels; the default text and voice channels are protected from deletion.
- Join a server and read its chats without entering voice or opening a microphone.
  Membership keeps the server in your sidebar. Offline departures are saved and sent when the server returns. Leaving your own running selfhost stops it after confirmation.
- Show or hide the participant list. Online status follows the background server
  connection, including while viewing another server. Voice participants appear
  beneath their channel.
- Administrator, moderator and member roles. Moderators create invitations and
  revoke their own; administrators also manage channels, roles, kicks and bans.
- One-time invitations last 24 hours; reusable invitations last one hour. Each
  type has a limit of 100 active links per server. Share full links privately.
- Link your devices on a particular server, sharing profile display, message
  editing and current permissions. One linked device can use voice at a time.
- Mandatory E2EE for voice, messages and images. Key setup happens automatically
  on clients; the server stores encrypted content and key packages. TLS pins,
  signatures and membership protect different boundaries. [Security model](docs/E2EE.md).
- Per-device server notification muting keeps unread counts and voice entry/exit
  cues. Audio settings include PTT, RNNoise, echo cancellation and gain control.
- English/Russian UI, profile avatars, message formatting, replies and images.
  The first-run guide helps with profile and microphone setup.

## Getting started with API 2

1. Set your name and audio devices in the client.
2. Create a server from the client; its creator becomes an administrator.
3. Use **Invite participants** to create a timed link. Recipients paste it into
   **Join server**. Joining does not automatically enter a voice channel.

On Windows, the installer sets only the Manager language. Choose
a local Server package or explicitly download a compatible release in Manager UI;
Server is installed and started only after confirmation.

For a clean permanent server, create a one-time **first administrator** invitation
in Manager or the host CLI. The first client creates and saves encryption keys;
there is no separate key generator. Further administrators join normally and are
promoted by an existing administrator. [Operator guide](docs/SERVER-API2.md).

For a clean Linux VPS, follow the **[Debian Server API 2 installation guide](docs/SERVER-DEBIAN.md)**:
trusted bootstrap, Docker/Compose, first-admin link, reboot checks, updates and backup/restore.

Self-hosting over the internet needs reachable ports: TCP 18443, TCP 18444 and UDP
18445 by default. NAT/CGNAT, firewall and VPN behavior can affect connectivity.
[Network check](docs/SELFHOST-CHECK.md). Local tests do not prove external UDP or
physical microphone/game/PTT behavior.

## Development

Windows x64: Node.js 24.22.1+, Go 1.27.3+, Visual Studio Build Tools with C++ and
Windows SDK. Set PAWTALK_GO if Go is not on PATH.

~~~powershell
npm ci
npm run native:build
npm run dev
~~~

Client and permanent Server build the same server/ core. [Architecture](docs/ARCHITECTURE.md),
[API 2](docs/API-V2.md), [implementation and verification journal](docs/MULTICHANNEL-PLAN.md).
No new production dependencies, automatic key rotation, forward secrecy or
cryptographic erasure of already delivered history are implied.

Report problems in [GitHub Issues](https://github.com/IlyaRusskikh/PawTalk/issues/new/choose),
without live invitations, secrets or personal network details. Report security
issues privately as described in [SECURITY.md](SECURITY.md).

Licensed AGPL-3.0-only. Preserve [third-party notices](THIRD_PARTY_NOTICES.md) and licenses/.
