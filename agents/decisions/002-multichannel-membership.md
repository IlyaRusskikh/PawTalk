# 002 — Multi-channel servers, membership and device identities

Status: product direction and logical schema accepted by the owner; implementation
has not started. The owner resolved the main Q1–Q7 product choices: one voice device,
main-device-approved group merging, retained roles, administrative CLI/Manager links,
ten-minute online linking and server-local profile data. Remaining onboarding and
edge-case proposals are explicitly marked. Detailed contracts and verification are tracked in
[the implementation plan](../../architecture/api.en.md).

Context: the current shared server core couples login to one LiveKit room and one
chat feed. Persistent membership, multiple channels and reversible device linking
need separate identity, authorization and connection lifecycles.

Decision: preserve the single server/ implementation for selfhost and serve. Add
invite-based persistent membership, separate server/voice connections, globally
recognizable public profile IDs, server-local reversible bindings and per-device
keys. Original message authors remain immutable. The main profile supplies effective
roles; unbinding never clears bans. One server secret derives purpose/channel keys;
the server never receives the secret or invitation-envelope opening keys.
The owner accepts self-hosted LiveKit's existing-media-token revocation limitation:
revoke API access, stop issuing grants and attempt media removal, but do not claim
immediate invalidation of every existing media token. One voice slot is an authorized
application-state rule, not proof against malicious replay of still-valid media grants.

The owner explicitly waived historical data migration because there are no active
users. Implement a fresh schema and retire the superseded runtime contracts instead
of maintaining a parallel legacy implementation. This does not authorize replacing
published releases or treating independent component versions as API versions.
Advertise the breaking contract and reject unsupported peers explicitly. Updating
Client or Manager alone cannot replace an installed permanent Server.

Consequences: no cryptographic channel ACL, automatic rekey on kick/ban, account
recovery code, custom-role UI or direct messages in this update. Existing recipients
can retain old content/keys. Historical releases remain immutable. Future DM relay
and multi-server key-contribution proposals remain in FUTURE-IDEAS.md, not this scope.

Verification: identity/link/invite replay and concurrency, current authorization,
voice eviction, E2EE fail-closed behavior, storage integrity and Client/Server/Manager
integration must pass before the new core is accepted. Native, container and physical
device/external-network evidence must be reported separately.
