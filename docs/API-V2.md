# API 2 — executable implementation contract

Status: published in compatible API 2 Client, selfhost, permanent Server and Manager;
current source implements this contract. See [published compatibility](COMPATIBILITY.md)
and the [Debian VPS guide](SERVER-DEBIAN.md). This breaking contract does not describe
historical installed API 1 releases. No migration or second production core is shipped.
Verification history is recorded in MULTICHANNEL-PLAN.md, with environment limitations.

## Identity and authentication

One installation creates two independent Ed25519 key pairs in protected main-process
storage: original profile identity and device signing. Public IDs are SHA-256 hex
of the raw 32-byte public keys. Each installation has its own original profile;
linking never copies private keys. Profiles are globally recognizable; bindings,
membership, roles, names and avatars are server-local. The profile identity key
certifies its device key. All clients validate key lengths, IDs and certificates.

Signature framing is concatenation of UTF-8 fields, each prefixed by an unsigned
32-bit big-endian byte length. No JSON canonicalization, separators or implicit
Unicode normalization. Maximum frame: 65536 bytes. Base64url is unpadded.

Device certificate fields:
`pawtalk-device-v2`, profile public key (base64url), device public key (base64url).

Request signature fields:
`pawtalk-request-v2`, server ID, authenticated transport binding, HTTP method, exact request URI including query,
challenge ID, challenge nonce (base64url), SHA-256 hex of exact body bytes.
GET without a body uses SHA-256 of zero bytes. The profile key signs the device
certificate; the device key signs requests. No key supplied by the server replaces
the client's local secret. Challenges last 60 seconds, are single-use, stored with
server identity, bounded and consumed transactionally with authentication.

`X-PawTalk-Proof` is base64url UTF-8 JSON with `binding`, `profileKey`, `deviceKey`,
`certificate`, `challenge`, `signature`. Maximum decoded size 2048 bytes.
Public config/challenge requests have no credentials. Signed requests register
or authenticate an original identity. Registered ordinary sessions use an opaque
256-bit bearer stored as SHA-256 by the API; TTL 12 hours. Session renewal requires
a fresh device proof. Every authorized request resolves current binding, membership,
ban and permissions. Changes do not wait for bearer expiry.

Server identity is a host-local Ed25519 seed persisted separately from all client
and E2EE secrets in server_state. Server ID = first 16 bytes of SHA-256(server public
key), hex. Public config includes identityKey and identitySignature over frame
`pawtalk-server-v2`, server ID, authBinding, `2`, name, initialized (`1`/`0`), revision
decimal. authBinding is `tls-sha256:<verified leaf fingerprint>` for native TLS or
`origin:<configured HTTPS origin>` behind a CA-authenticated reverse proxy. Client
checks binding against the actual verified connection, public-key hash against server
ID, and config signature before loading/sending credentials. Server enforces its
configured binding on each signed HTTP request. This prevents a malicious origin
from claiming another server ID and relaying its challenges. Explicit loopback-only
HTTP tests/dev may use their observed 127.0.0.1 origin; public dynamic Host is rejected.

TLS verification and certificate pinning happen before any invitation/session token
is sent. Development loopback transport is explicitly scoped; insecure public URLs
are rejected. Secret input lives in main-process IPC handlers, not localStorage.

## Version, state and errors

`GET /api/config` advertises `apiProtocolVersion:2`, `e2eeRequired:true`, `serverId`,
`name`, `initialized` and the capabilities from shared/membership.cjs. It exposes no
people, invitation credentials, fingerprints usable as credentials or key material.
Unsupported explicit protocols are rejected before authentication; a missing version
is historical API 1. API 1 clients cannot join the new core. API 2 clients show a
clear unsupported-server error for API 1 rather than downgrading membership/E2EE.

Errors are JSON `{error:{code,message}}`; codes are localized by clients. Statuses:
400 malformed, 401 missing/expired proof or session, 403 forbidden/banned,
404 missing resource, 409 conflicting state/voice occupied, 410 expired invitation
or attempt, 413 limits, 426 protocol/E2EE unsupported, 429 rate limit, 507 storage.
Do not include tokens, signatures, private keys, invite URLs or personal data in logs.
Time fields are UTC Unix milliseconds, intervals below are seconds. Deadlines are
server-authoritative, checked in requests as well as cleanup. Revisions are monotonic.

## Endpoint families

| Method and path | Authorization and result |
| --- | --- |
| GET /api/v2/challenge | Anonymous, rate-limited; challenge ID, nonce, expiry and server ID |
| POST /api/v2/session | Device proof; only an active, non-banned resolved member receives a session |
| POST /api/v2/invites/prepare | Device proof; token, device/profile proof, request ID; temporary attempt and encrypted package, no normal member access |
| POST /api/v2/invites/confirm | Fresh device proof bound to attempt; confirms saved package digest, atomically creates/restores membership and session |
| GET /api/v2/state | Session; server/channels, member/profile revisions, current permissions and own device group |
| POST /api/v2/heartbeat | Session; update presence, current revisions, no requirement to open UI or voice |
| POST /api/v2/leave | Session; end group membership, keep bindings/authorship/roles, revoke sessions |
| GET/POST /api/v2/invites | Moderator/admin; list own or all according to permissions; create client-encrypted package |
| DELETE /api/v2/invites/{id} | Creator moderator or admin; revoke and remove package, not member access |
| POST/PATCH/DELETE /api/v2/channels[/{id}] | Admin; CRUD, immutable ID/kind/protected designation |
| GET/POST /api/v2/channels/{id}/messages | Session/current permissions; bounded pages or ciphertext message |
| PATCH/DELETE /api/v2/messages/{id} | Session; original and caller currently resolve to same active group |
| POST/GET /api/v2/channels/{id}/attachments/{id} | Session; bounded ciphertext, staged upload then atomic message association |
| PATCH /api/v2/server | Session, effective administrator only; rename shared server with name/expectedName/requestId |
| PATCH /api/v2/profile | Session; edit resolved profile's server-local nickname/avatar, publish revision |
| POST /api/v2/voice/join | Session; claim one slot for resolved group and return room-scoped microphone-only grant |
| POST /api/v2/voice/leave | Session; release caller slot and request LiveKit removal |
| POST /api/v2/links[/{id}/propose,confirm] | Device proofs from main devices; reserve/propose/confirm binding and encrypted key delivery |
| POST /api/v2/devices/{id}/unlink,revoke | Main or self as allowed; unlink one, never restore old group |
| POST /api/v2/control | Current main plus acceptance from new main; same canonical profile/roles |
| PUT /api/v2/members/{id}/role | Admin; one built-in role now, schema permits later custom roles |
| POST /api/v2/members/{id}/kick,ban | Admin; reject administrator targets until role removed, preserve assignments |
| DELETE /api/v2/bans/{id} | Admin; revoke one ban action, other active bans remain |

The exact field validation/response types accompany each implemented family. Route
names are not permission checks by themselves. No API can read a supplied path or
execute a host command. Manager bootstrap is host-local, not a public admin endpoint.

## Two-phase invitations and bootstrap

Single invite: 24h, one successful activation, max 100 live. Reusable: 1h, max 100
live invitations (not uses). Reserved single invitations count toward the cap.
Client generates independent 32-byte admission token and package-opening key.
Only token hash reaches create API; plaintext token reaches prepare over verified
TLS. The opening key never enters API requests, logs, previews or database.

Full link extends the pinned PawTalk address fragment with `v=2`, `server`, `invite`,
`token`, `open` and package digest. Fragment secrets must be removed before storing
display addresses or update-room discovery entries. Clients persist member keys
and server identity separately from original full links.

Prepare stores attempt/reservation for 120s, bounded by invitation expiry; state
`reserved`. Single reservation excludes others. Reusable attempts can be independent.
Client validates package digest and AES-GCM, checks key ID, saves secret using OS
protection, then signs confirm. No voice/microphone test is required. Before confirm
there is no history/voice/admin access or normal roster entry.

Timeout marks attempt `expired`, closes temporary access, and revokes a single-use
invitation; that device must obtain a new invite. A reusable invite remains available
to other identities; unique `(invite,device)` rejects that failed device's retry.
Confirm and expiry race in one transaction. Successful confirm records redemption;
replay by the same device returns the successful state without a second use. Expiry
cleanup does not turn a confirmed attempt into a failed one. Revocation never erases
an already downloaded secret. Package deletion leaves nonsecret attempt metadata
needed for idempotency; a new authenticated session can be issued after a lost reply.

Bootstrap is a separate host-local 24h one-time setup link, at most one outstanding;
regeneration revokes the previous one. It is available only while server is not
initialized, never creates additional admin invitations on initialized servers.
The first client generates/saves server secret, submits only its fingerprint in
confirm and receives membership/admin. Metadata and consumption commit atomically.
Other members use ordinary invites; additional admins are promoted by existing admins.
Selfhost injects a fresh setup credential into its own trusted main process and
completes the same operation automatically. No separate E2EE generator UI remains.

## Encryption envelopes

AES-256-GCM, random 12-byte nonce, 128-bit tag; no plaintext fallback. A server root
secret is 32 random bytes, never a password. Root key ID = SHA-256(raw root) hex.
Use HKDF-SHA256, salt = raw 16-byte server ID, info = signatureFrame of
`pawtalk-key-v2`, purpose, channel ID (empty only for profile avatars), root key ID.
Purposes: `chat`, `voice`, `attachment`, `avatar`. 32-byte outputs. Members with root
can derive all outputs; this is not a channel ACL or forward secrecy.

Envelope fields: `version:2`, `keyId`, `nonce` (base64url), `ciphertext` (base64url,
includes tag). AEAD additional data is signatureFrame of `pawtalk-content-v2`,
server ID, purpose, channel ID, resource/request ID, original profile ID, root key ID.
Editors use original provenance; nonce is fresh on every encryption/edit. Channel
ID and original author never change when binding/unbinding profiles.

Invitation wrapping uses independent random opening key, not an admission token.
HKDF salt server ID, info frame `pawtalk-invite-v2`, invite ID; AEAD frame
`pawtalk-invite-package-v2`, server ID, invite ID, root key ID. Contents encode version,
server ID, root hex secret and key ID. Trusted link includes package SHA-256 digest.
GCM with the link's opening key authenticates contents even if storage is modified.
Request/device signatures authorize who creates/accepts operations; encryption is
not itself proof of a server role.

## Link and control transcripts

Source and target main devices create ephemeral X25519 key pairs locally. The private
halves never leave the devices, are not profile signing keys, and are discarded
after confirmation/cancellation. Public halves are raw 32-byte base64url fields
`sourceExchangeKey` and `targetExchangeKey` in the proposal. Validate public keys
and reject failed/all-zero shared-secret results through the platform crypto API.
The link token is independent, 32 random bytes; server stores its hash. It expires
after 600s without either side being able to extend it by polling.

The agreed transcript is signatureFrame of `pawtalk-link-v2`, server ID, request ID,
source root profile ID, target root profile ID, chosen root profile ID, source main
device ID, target main device ID, source exchange key, target exchange key, source
group revision decimal, target group revision decimal. Both main devices sign exactly
this transcript with their device signing keys. Both display the first 10 hexadecimal
characters of SHA-256(transcript), grouped for comparison. The receiving UI must show
the selected root and resulting role before confirmation. A main device cannot sign
away another main's authority; current revisions/control and bans are rechecked in
the same transaction as the binding update. Proposals alone never grant privileges.

X25519 shared secret feeds HKDF-SHA256 with salt=raw server ID and info=frame of
`pawtalk-link-delivery-v2`, request ID, SHA-256(transcript) hex. AES-256-GCM additional
data is the entire transcript. A device already holding the root encrypts the same
versioned root package used for invitations for the new device. Both existing member
groups must agree on the configured root key ID; linking is not key rotation.
Encrypted delivery is saved/checked locally before recipient confirms. A stale group
revision or newly active ban aborts the operation without partial membership changes.

Control transfer transcript is frame `pawtalk-control-v2`, server ID, root profile ID,
old main device ID, new main device ID, expected group revision decimal, operation ID.
Both devices sign it. Main transfer changes control only, never canonical identity
or role. Removing any other device removes only its binding. Removing current main
requires preceding transfer while other group devices remain. Group merging flattens
every member into the agreed root; no subgroup is resurrected on later unlink.

## Mutation inputs and projections

All ordinary JSON objects reject unknown fields, trailing JSON and oversized input.
Mutation request IDs are random 16-byte lowercase hex, scoped to original device;
identical retry returns the previous result, a different payload with that ID conflicts.
Path IDs are validated before SQL. Every name is trimmed, Unicode scalar-count
limited and excludes controls. Pagination limits are 1–100 by default (max 500),
with a single before/after cursor; cursor belongs to the selected channel.

- Session body: `{nickname,deviceLabel}`; signed header supplies immutable keys.
- Prepare: `{inviteId,token,requestId,nickname,deviceLabel}`. Returns `{attemptId,
  deadline,kind,keyPackage,packageDigest}`; bootstrap has no existing package.
- Confirm: `{attemptId,requestId,packageDigest,keyId}`; keyId must equal configured
  ID, or atomically initializes it for first bootstrap. Returns `{sessionToken,
  expiresAt,serverId,profileId,effectiveProfileId}`. Request proofs never contain root.
- Create invitation: `{inviteId,tokenHash,kind,keyPackage,packageDigest,requestId}`.
  Server chooses expiry from kind, validates hash/package limits, and binds creator
  to current authenticated original profile (not a supplied creator field).
- Channel create: `{kind,name,requestId}`; patch `{name,position,expectedRevision,
  requestId}`; IDs/protected status never accepted from callers.
- Message: `{requestId,keyId,nonce,ciphertext,attachmentIds}`; original authors and
  timestamp assigned by API. Edit `{requestId,keyId,nonce,ciphertext}` uses fresh nonce
  and immutable original provenance, cannot change channel or attachment ownership.
- Role: `{role,requestId}` with one of member/moderator/admin. Kick `{requestId}`;
  ban `{requestId,expiresAt,reason}` (null expiry = permanent). Removing one ban action
  never removes another action on the same subject.
- Profile patch `{nickname,avatarEnvelope,expectedRevision,requestId}` edits current
  canonical server-local profile. No global propagation. Other original profiles keep
  their own saved appearance for unlink; clients update rendered old messages by revision.
- State returns `{serverId,name,revision,self,channels,members,profiles,bindings}`.
  Self contains original/effective IDs, own devices/control, role/permissions and
  voice slot. Members is one entry per active canonical group; profiles/bindings keep
  author-resolution data needed for retained history. Unauthenticated state is forbidden.
- Heartbeat body is `{}`. Only authenticated live sessions update presence; a background
  roster poll or cached membership alone does not assert somebody is online.

Confirmation proves a signed claim by the device, not that an arbitrary modified
program genuinely saved a key. Compliant clients confirm only after a successful
local encryption-envelope check and protected-storage write. Bound body/proof limits,
max challenges/attempts/sessions and limits on ciphertext/attachment sizes are enforced
at the HTTP boundary, independently of SQLite CHECKs. Operational events record action,
opaque subjects and time, never request bodies, credential material or plaintext chat.

## Membership, groups, voice and storage

Original profile↔device is one-to-one for this release, certified as above. Current
bindings form flat stars; no self-links, chains or cycles. Group merge requires both
main devices to sign the same source groups, chosen root, expected revisions and
request ID. Flatten all sources transactionally. Unlink affects one original device,
never reconstitutes an old subgroup. Messages keep original author/device IDs.

Role assignments survive leave/kick/ban; bindings survive leave/kick. Ban action
snapshots all current original subjects, so unlink cannot remove it. Last active
administrator is protected; linked/dormant roles do not count. Main-device transfer
does not change canonical profile/role. Primary device cannot detach itself until
control is transferred when other group devices remain. No recovery code.

If the original ID-owning device then detaches, it regains its original public ID;
remaining devices rebase onto the current main device's original profile ID. Group
appearance and effective roles are preserved separately in group_profiles/group_roles,
without overwriting original standalone appearance/assignments. effective_profiles
and effective_profile_roles are read projections. An avatar retains its original
avatar_profile_id for AEAD until replaced by a client. No former subgroup is restored.
The owner explicitly accepted this edge policy on 2026-11-14;
plain control transfer still preserves ID.

Only one authorized voice slot per resolved group. A second device receives
`VOICE_OCCUPIED`, not an automatic takeover. Standard client holds at most one voice
session. Heartbeat each 15s; online if authenticated heartbeat within 45s. Clear
stale slots on restart; a live slot is renewed by owning session. Rooms use opaque
server/channel IDs. Initial media tokens last 60s; SDK refresh/existing sessions
are a separate lifetime. Attempt removal on leave/kick/ban; self-hosted replay limits
are accepted, documented and tested, not represented as immediate global revocation.

Current schema: server/membership.sql, embedded in the single shared Go core. New
data file, no migration. Never open legacy chat.sqlite as this schema or silently
delete arbitrary state. SQLite FK enabled per connection, STRICT types, transactional
mutations, no auth tables evicted by chat storage cleanup. State includes schema
version and stable server ID independent of TLS renewal/channel deletion. Unfinished
attachments have nullable message ID and expire after 10min; the API enforces ownership
and per-device bounds. Final attachment association shares the message transaction.

UI opens last selected existing text channel, otherwise protected General. Voice
never auto-starts on server selection. Local mute/unread settings are per device,
per server/channel and are not global account sync. Status panel and layout follow
MULTICHANNEL-PLAN.md; hidden right roster frees its space to main content.

### Channel order

POST /api/v2/channel-order takes {kind,items:[{id,revision}],requestId}.
Only channel.manage (administrator) may reorder. Items must include each channel
of the selected kind exactly once, with current revisions. The complete reorder
is atomic and idempotent by actor/requestId; membership, protected defaults and
channel identities remain unchanged. A concurrent edit returns CHANNEL_CHANGED.
Text and voice selections are independent; changing chat preserves active voice.

### Message UI navigation

The authenticated messages endpoint also accepts an optional positive `around`
message ID, or `ids` (at most 500 comma-separated positive IDs). These selections
are exclusive of before/after and of each other. Lookup always scopes IDs to the
requested text channel and current authorized membership; missing/deleted IDs are
omitted. It returns the same encrypted MessagePage shape. Clients resolve reply
previews from current originals instead of treating the embedded snapshot as live
content. Around queries provide a bounded chronological window for navigation.

Client send RPC may supply a 32-hex requestId. The main process retains the exact
encrypted packet for a bounded set of unconfirmed sends so a network retry cannot
create a duplicate message or reuse a nonce with altered ciphertext.

Server rename uses `{name,expectedName,requestId}`. Names are trimmed, 1–64 Unicode
scalars without control characters. A stale expectedName returns SERVER_NAME_CHANGED;
request replay is idempotent. The existing server_state.name field is updated in
the same transaction as the mutation receipt and revision. Identity, TLS binding,
E2EE keys and membership do not change. State/public signed config expose the new
name; clients persist the authenticated display name separately from signed config.
