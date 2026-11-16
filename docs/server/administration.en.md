# Membership, roles and invitations

[Русский](administration.ru.md) · [Documentation](../README.md)

A server has three roles: **administrator**, **moderator** and **member**. Administrators can manage channels, roles, kicks/bans and invitations. Moderators can create invitations and revoke their own. Permissions currently apply to the server, not separate private channels.

**First admin, permanent server:** Manager on Windows provides an initial-admin invitation; on Linux run `sudo pawtalkctl initial-admin --url`. It is a single-use 24-hour link available only before initialization. The first Client creates the E2EE root and saves it in OS-protected storage; Manager/Server do not receive a plaintext root. Additional administrators join with normal invitations and receive a promotion from an existing administrator.

**Normal invitations:** one-time links last 24 hours, reusable links one hour; the current limit is 100 active links of each kind per server. An expired invitation does not remove existing members. Keep complete links private.

Removing a member prevents new authorized API operations but **does not** rotate a server-wide root or erase ciphertext/keys already obtained. Deleting a text channel permanently removes stored history and attachments. See [security architecture](../../architecture/security.en.md).
