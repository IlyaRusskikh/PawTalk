# System architecture

[Русский](overview.ru.md) · [Index](README.md)

PawTalk is a monorepository with **three independently released components**. The **Client** is an Electron/React Windows application. The **Server** is a Go API and LiveKit media runtime; both temporary Windows self-host and permanent Windows/Linux deployments use the shared `apps/server/` core. **Manager** is the host-level installer/controller for permanent servers, with Windows UI/services and Linux CLI/Compose.

~~~text
Windows Client ─ TLS/API + media ─► PawTalk Server (Go API + LiveKit)
      │                               │
      ├─ device keys in OS vault     ├─ membership, roles, channels
      ├─ locally encrypted content   ├─ encrypted messages/attachments
      └─ temporary Server host       └─ state + SQLite for permanent Server
                                         ▲
                                     Manager
                            (Windows service / Linux Compose)
~~~

API 2 unifies identity, admission and channels. Membership grants access to server APIs; entry into voice is a separate action. The permanent Server persists SQLite schema 2; temporary self-host keeps membership/chat state in memory. Server sees TLS endpoints and metadata, but not plaintext content protected by E2EE.

**Release boundaries:** Client `client-v*`, Server `server-v*`, Manager `manager-v*`. Manager's Windows and Linux packages share a tag; release notes must describe both where applicable. Published API 1 is incompatible and no data migration is provided. [Compatibility](../docs/server/compatibility.en.md).

[Components](components.en.md) · [Security](security.en.md).
