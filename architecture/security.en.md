# Security and E2EE boundaries

[Русский](security.ru.md) · [Index](README.md)

## Protected access in API 3 development builds

Server applies signed policy changes and checks current membership, device identity, channel access and history position when serving protected data. Client verifies the relevant policy and epoch proofs. Live keys, archive keys and attachment keys have separate purposes. Archive packages follow the granted history scope. Clients prepare addressed recovery packages and keep private device keys and recovery codes in their own custody.

Revocation stops delivery to the removed recipient and starts rotation. Still-admitted writers may use an allowed previous generation for up to 60 seconds from the effective revoke. A new rotation leaves that deadline in place. Previously delivered data and keys remain on the devices that obtained them. The room avatar has a separate key with device and recovery packages.

Server sees operational metadata. LiveKit media grants have a finite lifetime. The [implementation map](../agents/decisions/012-protected-access.en.md) and [acceptance matrix](../agents/testing/protected-access-acceptance.md) record the checks and available environments.

## API 2

API 2 requires end-to-end encryption of **voice, text and image attachments**; TLS and E2EE serve different purposes.

| Mechanism | Protects | Does not guarantee |
| --- | --- | --- |
| TLS + invitation fingerprint | Authenticated transport to the intended server | Confidentiality of server-side metadata |
| Signed device identity | Ownership and freshness of device proofs | Permission without current server membership |
| Timed invitations and roles | Admission and access to new API operations | Erasure of already received content |
| E2EE | Content against the Go API/LiveKit Server | IPs, timing, sizes, channel/member metadata |

The first authorized Client generates a random 256-bit server root, stores it in OS-protected storage, and supplies encrypted packages for later invitations. Key agreement and derived channel/purpose keys use cryptographic contexts bound to apps/server/channel identities. Text/attachments use AES-256-GCM, voice uses the LiveKit E2EE SDK; Client device linking uses an authenticated, confirmed exchange. Client roots/private signing keys are not included in Server backups.

**Critical limits:** participants on a server share a root; channel separation is contextual, **not cryptographically restricted private channels**. Leaving, kick/ban, unlink and invitation expiry do not rotate the root or revoke prior messages/keys. No forward secrecy, lost-root recovery or cryptographic erasure is claimed. Already issued media grants have a finite reuse interval. The server sees metadata; a compromised endpoint exposes its local keys.

Separate **artifact trust** from E2EE: signed update manifests, checksums and immutable container digests protect distribution, not end-to-end chat confidentiality. [Security disclosure](../SECURITY.md) · [API](api.en.md).
