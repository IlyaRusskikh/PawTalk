# Security policy

[Русский](SECURITY.ru.md)

### Supported versions

PawTalk is a **public preview**, not a stable release. Component versions are independent. Current published versions:

| Component | Current published release |
| --- | --- |
| Client | [client](https://ilyarusskikh.github.io/PawTalk/downloads/#client) |
| Server (permanent Linux/Windows rooms) | [server](https://ilyarusskikh.github.io/PawTalk/downloads/#server) |
| Manager | [manager](https://ilyarusskikh.github.io/PawTalk/downloads/#manager) |

Security fixes ship as new releases of affected components. The latest published
release of each component is supported; backports to older releases are **not
guaranteed**. API compatibility with an older server does not imply security
support. Updating Client or Manager does not replace an installed permanent
Server; update Server separately.

In the development tree, Client and Server use one shared [server/](server/) core.
Auth, chat and API fixes apply to both hosting modes; current builds maintain no
separate core copy or backport patch. Temporary rooms receive fixes through Client
releases; permanent rooms through Server releases. Updating one component does not
update the other component's installed binaries.

Published Client 0.10.1 still uses Go Server 0.8.0 with a security backport:
[historical pin](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.1/bundled-server.json)
and [patch](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.1/build/bundled-server-security.patch).
Client 0.11.0 delivers the shared core; historical Client 0.10.1 is unchanged. See
[build and verification details](architecture/components.en.md) and [compatibility](docs/server/compatibility.en.md).

### Reporting a vulnerability

Please **do not open a public issue containing working exploits, secrets, or details of an unpatched vulnerability**.

1. Open this repository's **Security** tab and look for **Report a vulnerability** (GitHub private vulnerability reporting).
2. If available, report privately. Include affected versions, expected and actual behavior, safe reproduction steps, and impact. Never attach real passwords, keys, or live invitations.
3. If private reporting is unavailable, do not post the vulnerability details in Issues. You can open a normal issue **requesting a private contact channel only**, with no technical vulnerability details.

Response times and fix timelines are not guaranteed. Security fixes are shipped as new releases rather than overwriting existing tags or binaries.

### Known limitations

- API 2 in the development tree requires E2EE for voice, text and attachments. Clients create and retain the root; the server stores encrypted packages. This does not update published API 1 binaries. [E2EE model](architecture/security.en.md).
- Leaving, kicks and bans revoke server access but cannot erase delivered data or keys. Automatic rotation and forward secrecy are absent. The server sees metadata, roles and presence; issued LiveKit tokens retain a documented reuse window.
- Windows installers are not yet Authenticode-signed. Published SHA-256 checksums and Ed25519-signed update manifests serve different purposes and do not replace a Windows publisher signature. [Updates](docs/UPDATES.md).
- Hardware acceptance remains open for physical microphones, game/PTT behavior, external networks, and 30-participant loads. [Acceptance checklist](architecture/verification.en.md).
