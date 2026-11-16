# PawTalk Server 0.11.1 — API 2 membership and multiple channels

[Русский](server-v0.11.1.ru.md) · [Canonical snapshot](server-v0.11.1.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

### Added

- Multiple text/voice channels, protected defaults, administrator-controlled server name and channel order. Membership works without voice.
- Signed device identities, sessions, a persistent roster and server-local device bindings. The primary profile determines group roles; linking grants shared message control, while unlink restores an independent profile without rewriting original authors.
- Equal administrators, a fixed invitation-only moderator role, kicks, temporary/permanent bans, role preservation on rejoin and one voice device per group.
- Single-use 24-hour and reusable one-hour invitations, capped at 100 active invitations of each type. Admission reservation/confirmation, one-use initial administrator setup and opaque encrypted key packages.

### Fixed

- Standalone Server release checks build the Client renderer required by the Windows Manager admission test.

- Idempotent mutations and revision checks protect retries and conflicting channel/control updates. A lost control-transfer response can be retried safely.
- Authenticated denial responses distinguish bans from lost membership and expose available expiry; link status exposes participant names only to the two proven devices.

### Changed

- API/data schema 2 replaces the old core; API 1 is unsupported. E2EE is mandatory: clients create the secret, and Server stores encrypted key packages, messages and attachments. Clients derive channel/purpose keys from the server secret.
- Selfhost and permanent Windows/Linux servers share one core. Kick/ban/departure revoke membership and sessions; compliant clients disconnect voice when access is revoked.

### Install or update

Install Manager 0.5.1 and Client 0.12.1, then Server 0.11.1 with a fresh API 2 data directory. Retain the API 1 installation and backup: no automatic history/password/membership migration exists; old clients and invitations are incompatible. Do not restore an API 1 backup into API 2. Stopping/replacing a server interrupts its calls. Create the first administrator's one-use invitation through CLI/Manager; existing administrators appoint later administrators in Client. Updating Client does not replace a separately installed Server.

## Full release record

The [unchanged bilingual snapshot](server-v0.11.1.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
