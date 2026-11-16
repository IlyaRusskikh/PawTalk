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
