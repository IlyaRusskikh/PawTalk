# Published component compatibility

[Русский](compatibility.ru.md) · [Documentation](../README.md)

The published, mutually compatible **API 2 preview** set verified on 15 November 2026 is:

| Component | Release |
| --- | --- |
| Windows Client | [client-v0.12.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.12.1) |
| Permanent Server | [server-v0.11.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.11.1) |
| Windows/Linux Manager | [manager-v0.5.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.5.1) |

These are **a dated verified combination, not installation pins**. For any newer releases, verify the release-specific requirements in the [live catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and [release notes](../../releases/README.md).

API 2 requires server API/data schema 2 and mandatory E2EE. **API 1 clients and servers cannot interoperate with API 2; no automatic migration of old membership, chat databases, passwords or backups exists.** Keep legacy data separate rather than importing it as API 2. Updating Manager does not automatically upgrade an installed Server.

The Server and Manager each have their own release tag even though the Manager package contains Windows and Linux tooling. No separate OS-specific Manager version exists.

## Development feature capabilities

The source retains API/data schema 2 and adds optional activity-v1, attachment-removal-v1, link-cancel-v1, server-avatar-v1, polls-v1, system-poll-results-v1 and chat-events-v1. Upgrade Server first. Without capabilities, basic chat/voice remain available; avatar/poll creation is hidden and unsupported attachment removal/link cancellation asks for a Server update. Older Clients ignore extra state fields and display a poll as question text without voting controls. Notification mutes and the jump button are local Client features. Active chats use an authenticated WebSocket when chat-events-v1 is advertised; older Servers keep polling. Manager API and release contracts are unchanged.

Existing API 2 databases gain additive tables without rewriting identities or legacy tables; this is not API 1 migration. See [implementation contracts](../../architecture/chat-features.en.md).
