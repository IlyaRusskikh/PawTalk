# Component and source map

[Русский](components.ru.md) · [Index](README.md)

| Responsibility | Primary implementation |
| --- | --- |
| Client window/UI, audio, settings | [`apps/client/windows/src/`](../apps/client/windows/src), [`apps/client/windows/electron/`](../apps/client/windows/electron) |
| Client↔Server sessions, invitations and E2EE | [`apps/client/windows/electron/membership-client.cjs`](../apps/client/windows/electron/membership-client.cjs), [`apps/client/windows/src/membership.ts`](../apps/client/windows/src/membership.ts) |
| Go API, auth, invitations, moderation, voice grants | [`apps/server/membership_*.go`](../apps/server), [`apps/server/main.go`](../apps/server/main.go) |
| Permanent storage contract | [`apps/server/membership.sql`](../apps/server/membership.sql) |
| Windows Manager UI and service controller | [`apps/manager/windows/desktop/`](../apps/manager/windows/desktop), [`apps/manager/windows/service/`](../apps/manager/windows/service) |
| Linux Manager CLI, transactions and verification | [`apps/manager/linux/pawtalk_manager/`](../apps/manager/linux/pawtalk_manager), [`apps/manager/linux/pawtalkctl`](../apps/manager/linux/pawtalkctl) |
| Managed Linux deployment | [`apps/manager/linux/deploy/compose.server.yaml`](../apps/manager/linux/deploy/compose.server.yaml), Manager systemd units |
| Builds, release manifests and CI | [`tooling/`](../tooling), [`.github/workflows/`](../.github/workflows) |
| Integration, security and release tests | [`tests/`](../tests), [Go tests](../apps/server) |

The Windows Client packages the shared Go/LiveKit core for temporary rooms; a standalone Server release packages the core for permanent hosts. Keep these build inputs aligned; historical binaries are immutable.

Manager's host permissions are distinct from the **administrator role within a PawTalk Server**. A root/sudo or Windows service operator is not automatically an E2EE member and does not possess client keys.
