# PawTalk — your voice, your server

[Русский](README.ru.md) · [User guides](docs/README.md) · [Architecture](architecture/README.md) · [Downloads](https://ilyarusskikh.github.io/PawTalk/downloads/)

**PawTalk** is an open-source voice and text chat application for friends and gaming groups. Create a temporary server right in the Windows client, or run your own always-on server on Windows or Linux with PawTalk Manager. There is no central PawTalk account.

## Why PawTalk?

Want a familiar place to talk and share messages, but prefer to control the server yourself? PawTalk combines voice channels, text chats, private invitations and a lightweight self-hosting workflow.

| | PawTalk | Discord | TeamSpeak |
| --- | --- | --- | --- |
| Hosting | Temporary server in the client or your own permanent server | Discord-hosted service | Self-hosted server options |
| Getting started | No central account; join through a server invitation | Account and Discord service | Server connection/identity model |
| Focus | Voice + text for small communities | Broad community/social platform | Voice-centric communication |
| Encryption | Mandatory end-to-end encryption for voice and content in published API 2 | Different security architecture; do not infer equivalence | Depends on version and configuration |

This is a difference in product approach, **not** a claim that one application is universally faster, safer or better. PawTalk is a **preview**: hardware and internet-network acceptance testing remains incomplete.

## What you can do

- Make a temporary server or join a permanent one; joining does not turn on your microphone or enter voice automatically.
- Create voice and text channels, invite members, use administrator/moderator permissions.
- Send formatted messages, photos, videos, documents and voice messages; organize interactive checklists, reply to messages and link devices within a server.
- Preview attachments before sending, browse media galleries and use Markdown tools; see [chat features and server requirements](docs/client/chat.en.md).
- Adjust microphone, output, Push-to-Talk, RNNoise noise reduction and notification sounds.
- Use mandatory E2EE for voice, messages and attachments; see [security boundaries](architecture/security.en.md).

Client 0.15.0 creates API 3 temporary rooms with channel-specific keys. Existing API 2 permanent rooms remain compatible with the new Client. Migrating a permanent room requires Server 0.14.1 or later and Manager 0.7.0. Client 0.15.1 and Server 0.14.2 add role-colored mentions in protected rooms. See [compatibility and upgrade requirements](docs/server/compatibility.en.md#protected-access-api-3).

## Download and start

- [Windows Client](https://ilyarusskikh.github.io/PawTalk/downloads/#client) — communicate, create a temporary server.
- [Server Manager](https://ilyarusskikh.github.io/PawTalk/downloads/#manager) — install and operate a permanent Server on Windows or Linux.
- [Server](https://ilyarusskikh.github.io/PawTalk/downloads/#server) — independently published server component.

Start with [first conversation](docs/client/first-steps.en.md), [Windows Manager](docs/manager/windows/installation.en.md), or [Linux VPS](docs/manager/linux/installation.en.md). [Full guide index](docs/README.md).

## Important limits

The published API 2 family is incompatible with API 1; there is **no automatic migration** of old server data or membership. All channels on one server currently share the E2EE root; there are no cryptographically private per-channel permissions or automatic key rotation after removal. A permanent server requires reachable TCP/UDP ports. Windows x64 is the published Client platform; Windows and Linux are **server-management platforms**, not additional desktop voice clients.

PawTalk uses [AGPL-3.0-only](LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.md). [Report issues](https://github.com/IlyaRusskikh/PawTalk/issues/new/choose) without invitations, secrets or private network reports. [Security disclosure](SECURITY.md).

Development source also includes media/document attachments, voice messages, editable interactive checklists, Markdown tools and message preview, alongside channel notification mutes, identity-bound mentions, automatic away status, administrator-managed server avatars, encrypted polls and shared WebSocket updates with polling fallback. These require compatible Client/Server builds; published installers are unchanged. See [development chat guide](docs/client/chat.en.md#development-source-additions).

For an isolated Server from current Windows source, use **npm run review:server**, then **npm run review** for Client. [Server review setup](architecture/development.en.md#native-server-review-on-windows).

With GNU Make installed, **make client-start/client-stop**, **make manager-start/manager-stop** and **make server-start/server-stop** control development instances. Run **make help** for options; see [Make review commands](architecture/development.en.md#make-review-commands-on-windows).

Source ownership and directories: [repository layout](architecture/repository-layout.en.md).
