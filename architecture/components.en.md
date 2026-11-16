# Component and source map

[Русский](components.ru.md) · [Index](README.md)

| Responsibility | Primary implementation |
| --- | --- |
| Client window/UI, audio, settings | [`src/`](../src/), [`electron/`](../electron/) |
| Client↔Server sessions, invitations and E2EE | [`electron/membership-client.cjs`](../electron/membership-client.cjs), [`src/membership.ts`](../src/membership.ts) |
| Go API, auth, invitations, moderation, voice grants | [`server/membership_*.go`](../server/), [`server/main.go`](../server/main.go) |
| Permanent storage contract | [`server/membership.sql`](../server/membership.sql) |
| Windows Manager UI and service controller | [`manager/desktop/`](../manager/desktop/), [`manager/windows/`](../manager/windows/) |
| Linux Manager CLI, transactions and verification | [`manager/pawtalk_manager/`](../manager/pawtalk_manager/), [`manager/pawtalkctl`](../manager/pawtalkctl) |
| Managed Linux deployment | [`manager/compose.server.yaml`](../manager/compose.server.yaml), Manager systemd units |
| Builds, release manifests and CI | [`scripts/`](../scripts/), [`.github/workflows/`](../.github/workflows/) |
| Integration, security and release tests | [`tests/`](../tests/), [Go tests](../server/) |

The Windows Client packages the shared Go/LiveKit core for temporary rooms; a standalone Server release packages the core for permanent hosts. Keep these build inputs aligned; historical binaries are immutable.

Manager's host permissions are distinct from the **administrator role within a PawTalk Server**. A root/sudo or Windows service operator is not automatically an E2EE member and does not possess client keys.
