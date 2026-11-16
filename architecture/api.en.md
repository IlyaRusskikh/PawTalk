# API 2 contract

[Русский](api.ru.md) · [Index](README.md)

The published API 2 is a **breaking protocol**. Client identifies API version and required server capabilities before membership/authentication proofs; it does not silently fall back to API 1. Server and Manager enforce matching API/data schema 2 when installing, updating or restoring.

## Identity and authorization

Each Client device has its own signing identity and server-scoped membership. Signed challenges bind authentication to a server and freshness; sessions and role checks gate member, channel, invitation and voice actions. Linking devices is a separately confirmed, server-local protocol, not a global account.

## Admission

Permanent Server bootstrap: host-controlled initial-admin link, one use within 24 hours; the first client creates/stores the server's E2EE root. Normal invitation: an administrator/moderator issues one-time (24 h) or reusable (1 h) access and an encrypted root package. Admission reserves, decrypts/validates and confirms; the package-opening key stays in the URL fragment rather than in HTTP requests. Revocation and expiration stop **new** joins, not existing membership.

## Endpoint families and state

The implementation contains protocol/version discovery; device challenges and signed proofs; two-phase invitations; membership/roles/moderation; channel CRUD/order; text messages, revisions and attachments; device linking; voice grants and current membership presence. Errors distinguish incompatible protocol, authorization, expired invite and connectivity failures. Clients cannot infer voice success merely from healthy HTTP.

**Source of truth:** [Go protocol handlers](../server/membership_protocol.go), [HTTP routes](../server/membership_http.go), [auth](../server/membership_auth.go), [invites](../server/membership_invites.go), [SQL](../server/membership.sql) and [contract tests](../server/membership_protocol_test.go). Avoid hardcoding an incomplete endpoint list in application-facing tutorials.
