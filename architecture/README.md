# PawTalk architecture

[Русский](README.ru.md) · [Project](../README.md) · [User documentation](../docs/README.md)

This section describes the technical contracts of the **published API 2 release family**. Code on `main` may be ahead of a published tag: use immutable component release tags when assessing production compatibility.

- [System overview](overview.en.md) — components, responsibilities, runtime topology
- [Component map](components.en.md) — implementation ownership and entry points
- [API](api.en.md) — identity, admission and endpoint families
- [Data](database.en.md) — SQLite schema 2 and lifecycle
- [Security](security.en.md) — authentication, E2EE, trust and limitations
- [Networking](networking.en.md) — transport boundaries and ports
- [Audio](audio.en.md) — media flow, processing, encryption
- [Update trust](updates.en.md) — versions, manifests, signatures
- [Development](development.en.md) — build, local setup
- [Verification](verification.en.md) — test levels and claims
- [Releasing](releasing.en.md) — independent candidate/publication process

The authoritative detailed shapes remain [the server implementation](../server/), [schema SQL](../server/membership.sql), [Client](../src/) and [executable tests](../tests/). Treat descriptions as a maintained map, **not** a replacement for verified contracts.

- [Development chat extensions](chat-features.en.md) — optional capabilities, encrypted avatars/polls, mention and activity metadata (development source).

- [Connection audit](connection-audit.en.md) — event delivery, retained polling and verification limits.
