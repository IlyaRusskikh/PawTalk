# Published component compatibility

[Русский](compatibility.ru.md) · [Documentation](../README.md)

The published, mutually compatible **API 2 preview** set verified on 15 November 2026 is:

| Component | Release |
| --- | --- |
| Windows Client | [client-v0.12.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.12.1) |
| Permanent Server | [server-v0.11.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.11.1) |
| Windows/Linux Manager | [manager-v0.5.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.5.1) |

These are **a dated verified combination, not installation pins**. For any newer releases, verify the release-specific requirements in the [live catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and [release notes](../../releases/README.md).

API 2 requires server API/data schema 2 and mandatory E2EE. **API 1 clients and servers cannot interoperate with API 2; no automatic migration of old membership, chat databases, passwords or backups exists.** Keep legacy data separate rather than importing it as API 2. Updating Manager does not automatically upgrade an installed Server.

The Server and Manager each have their own release tag even though the Manager package contains Windows and Linux tooling. No separate OS-specific Manager version exists.

## Prepared release sources

The [Client 0.13.0](../../releases/client-v0.13.0.en.md) and
[Server 0.12.0](../../releases/server-v0.12.0.en.md) release sources retain API/data
schema 2. Upgrade Server first to enable the added capabilities below. Manager
0.5.1 remains compatible and installs the Server separately; it does not bundle
the new Server. This source combination does not change the published catalog.

## Development feature capabilities

The source retains API/data schema 2 and adds optional activity-v1, attachment-removal-v1, link-cancel-v1, server-avatar-v1, polls-v1, system-poll-results-v1, chat-events-v1, server-events-v1 and message-events-v1. Upgrade Server first. Without capabilities, basic chat/voice remain available; avatar/poll creation is hidden and unsupported attachment removal/link cancellation asks for a Server update. Older Clients ignore extra state fields and display a poll as question text without voting controls. Notification mutes and the jump button are local Client features. Active chats use an authenticated WebSocket when chat-events-v1 is advertised; older Servers keep polling. Manager API and release contracts are unchanged.

Existing API 2 databases gain additive tables without rewriting identities or legacy tables; this is not API 1 migration. See [implementation contracts](../../architecture/chat-features.en.md).

media-files-v1 enables encrypted attachments up to 50 MB; older API 2 Servers retain 2 MB. checklists-v1 gates checklist creation/editing/checking. Older Clients render checklist titles and ignore the additional encrypted fields; file-only messages have no media viewer there. Upgrade Server before Client to enable all features. Manager contracts are unchanged.

The optional checklist-events-v1 capability pushes versioned check snapshots through the existing message WebSocket. Client polling remains a fallback on older Servers.

`media-gallery-v1`: up to ten encrypted file entries and their saved video posters, with at most twenty unique attachment IDs per message. New Clients gate gallery sends on this capability; older single-file messages remain supported. Older Clients need an update to display galleries. No API/data version or Manager migration is required.

## Protected access (API 3)

Updated Clients use the optional `roleColors` field in the protected channel roster to color verified role mentions. Upgrade Server to expose these colors. Older peers continue to use the default mention style.

Managed migration through the Client requires Server 0.14.1. On Server 0.14.0, the migration dialog cannot read a Manager-prepared checkpoint. If a room is already in maintenance on that version, roll back in Manager before updating Server and preparing again.

Client 0.15.0 creates new temporary rooms with API 3 and can still join API 2 permanent servers. Clients through 0.14.1 require API 2. Permanent Server 0.14.0 keeps an existing API 2 room on API 2 until the owner explicitly activates a prepared migration. Use Manager 0.7.0 for the host migration workflow. The migration workflow freezes the API 2 source. Active API 2 bans still apply to the effective profile after cutover and can be lifted through API 3 by a moderator with the ban permission. The lift is recorded in the signed API 3 policy. Readmission requires a valid invitation.

With updated Client and Server, an active migrated member can open an API 3 invitation from their original Client profile and device. The Client authenticates the existing membership and enrolls its agreement key without consuming a use of the invitation. Existing roles and access rules still apply. A device that can access the channel publishes the new key packages.

New migration checkpoints and temporary rooms use policy projection v18 in current development builds. After cutover, the owner Client that retains the API 2 room key re-encrypts the shared avatar locally on its first eligible connection. A later device receives its own key package from a device that can already open the avatar. A replacement device can restore an avatar through its profile's registered recovery package.

Device recovery requires Client and Server builds that support the signed `recovery.device` action and scoped attestations v2. The recovery bundle pins the same server and policy genesis when joining from a replacement device. An earlier development Client stops policy replay on the new action. A newly prepared migration registers the verified migration recovery code in API 3. Existing migration checkpoints retain their earlier format. After switching a newly prepared server, the owner can paste the migration code into the recovery setup to export a portable bundle without replacing the code.

An updated Client can change the address of a saved API 3 server even when the previous endpoint is unreachable. With a bare address the Client reuses a saved certificate fingerprint if available. If the certificate changed, use the server's current address link with its fingerprint. The Client verifies the same server identity and policy genesis and authenticates the existing device before saving the replacement address.

Ownership transfer requires support for the signed `owner.transfer` action and v2 attestations that identify the signing profile. Server identity and the pinned policy genesis are preserved. An earlier development Client rejects the new action during policy replay.

Adding another device to an existing protected profile requires Client and Server support for the signed `device.bind` action. Approval keeps existing devices and sessions active. The new device uses its own encryption key and may wait for channel key delivery under the profile’s current permissions. All Clients on the protected server need to understand this action during policy replay.

Linking existing API 3 profiles and detaching them require support for the signed `profile.link` and `profile.unlink` actions. Moved devices reopen their sessions under the chosen primary profile. Detachment ends sessions for the detached devices. Earlier invitations keep their original signed issuer and issuance policy.

Direct rebinding of a detached device requires a Client that stages a fresh agreement key and a Server that supports signed rebind eligibility and binding receipts. An earlier detachment without that eligibility still permits readmission through a new invitation. Binding an eligible device again applies the chosen primary profile's current roles.

Newly frozen migrations preserve linked profiles and device origins in the signed initial policy. Earlier migration checkpoints keep their existing format. The signed `scope.device` action lets an owner hand over scoped attestation signing to another active device of the same profile. After a handover, current attestations use v2, including after a handover back to the original device.

Projection v9 commits channel settings in the per-channel proof. Delegated settings edits require policy projection v9 or newer and Client and Server support for `channel.settings.scoped`. Earlier projection versions retain their verification rules. New temporary rooms and migration recipients use v18. Earlier signed policies remain readable.

Updated Client and Server can verify a delegated settings receipt against the signed operation and preceding attestation. With a Server that lacks the receipt route, Client waits for the regular attestation of the new revision.

With updated Client and Server, Administrator opens verified role, category and channel editors. Server limits the full chain to the active owner and members with Administrator. Builds without this extension retain their previous editor behavior.

`protectedExplicitAdminView` lets administrators explicitly list themselves and other administrators in a channel's view rules. The explicit allow remains if the listed profile later loses Administrator. Update Server and all API 3 Clients before using this option. Earlier development Clients that replay the full policy can reject the edit.

`protectedOwnRoleStyle` lets administrators edit the name, color and icon of their own highest role. Their existing grants, hierarchy, member grouping and mentionability remain subject to the usual role hierarchy. Update Server and all API 3 Clients before using this option.

The API 3 server state includes empty categories for the active owner and administrators with full policy access. Their client can create a channel directly from that category. Other users receive categories that contain a channel they can view.

Projection v10 adds separate channel-scoped proof of `channel.access.edit` and applicable role rules. Projection v11 adds a rank proof for selected profiles. Projection v12 also binds whether those profiles bypass channel ACLs through ownership or `server.administrator`. Projection v13 also binds the live recipients grouped by profile. A scoped live rotation claim opens these groups only for the executor whose lease already permits the full current recipient set. Projection v14 also binds the archive groups using separate opening domains. A scoped archive lease opens only its archive recipients. Projection v15 additionally binds the limited revision audience per profile at the original message position. The scoped revision basis opens only the eligible limited audience and retains the earlier flat proof for legacy revisions. Projection v16 also commits to the effects of a single scoped role denial of `channel.view`. The live rotation claim can open the affected profiles for the signed role edit. For this transition, the executor can verify the exact live recipient groups against the predecessor attestation and publish a marked live epoch before the successor attestation. Scoped clients check the marker and their admission before using the addressed live key. The archive rotation uses independent archive recipient groups and checks its sources against the live chain for the same role change. A scoped edit before the successor attestation proves the surviving limited audience at the original position and uses the wrapping key of the verified archive epoch. Projection v17 binds the issuer authority, admission and use proofs for invitations. After a first-time admission, an existing eligible reader can publish the marked live key before the successor attestation. For full history, an eligible archive reader can also publish a marked archive key that links the prior archive head and the uncovered live generations. The newcomer verifies the admission position for live use and obtains older messages through the archive. Projection v18 binds role assignment authority, applicable channel rules and the recipients of a signed assignment. A key recipient checks the delegate and target eligibility through a blinded identifier for the source roster. For a FullHistory-only change, the client verifies the signed transition and keeps using the existing live key while archive rotation is pending. Updated Client uses a v10 baseline and offers v18 when previewing a policy change. A signed change commits the transition. Stored v9–v17 proofs remain verifiable. Client stops verification at an unsupported revision.

Updated v17 Clients and Servers also support one live rotation for consecutive first-time admissions backed by ordered signed receipts from an attested policy. Full-history admissions can additionally share an archive rotation. Each receipt binds that device's admission position. Previously published epochs keep their original signed basis when an intermediate policy is later attested.

Updated API 3 Clients and Servers can negotiate partial responses for individual scoped key proofs above 16 MiB. Each continuation checks current access. Rotation claims also retain the original active lease, and the client checks the complete response digest before parsing. Small responses keep their JSON format.

With `protectedPollResultTasks`, Server closes voting at the deadline and waits for an updated Client to publish the separate result. The executor must be able to read the original poll and have a ready live package. Previously published results retain their format and system signature.

`media-variants-v1` (API 2) and `protectedMediaVariants` (development API 3) enable new media writes after a Server upgrade. Existing attachments remain readable, and an updated Client uses the legacy send format against a Server without the capability. An earlier API 2 Client with gallery support opens the original and ignores the additional descriptors. In API 3 development rooms, update receiving Clients before sending variants because older development builds only recognize the legacy signed attachment references. Client and Server retain their existing limits and schemas. See [the media contract](../../architecture/chat-features.en.md#media-variants).

API 3 servers that advertise protectedEvents accept a pinned, bearer-authenticated WebSocket at /api/v3/events. Existing clients receive resync, state, chat and heartbeat frames. A chat invalidation identifies a channel only after a scope and original-position check at dispatch. Servers advertising `protectedMessageDelivery` also accept the client opt-in `&delivery=1`. These streams can deliver new encrypted records with the current history boundary after checking session and history access in the same bounded transaction that writes the frame. The Client verifies the record through its existing message verifier. History, gaps, unsupported frames and reconnect resync use HTTP. Update Server and Client to enable direct delivery.

With `protectedPresence`, updated API 3 Clients report device activity on the existing background interval. A server lists online, away or offline only for profiles already visible in the requested roster. Any active device makes its profile online. Devices expire after 60 seconds without a report. Older servers omit presence. Earlier API 3 Clients do not report activity.

API 3 state can include `voiceParticipants` for each visible voice channel. The list includes only active sessions with a media grant and contains profile IDs, names and the current media session IDs used to address moderation actions. Older servers omit the list. Each moderation action checks the applicable channel permissions and target session. PawTalk enforces the current voice capacity when reserving a slot, so changing it takes effect in an occupied room.

API 3 allows 1,200 authenticated requests per minute per effective member profile. The owner and members with the Administrator permission are exempt from this request budget. Public requests and sign-in remain limited by the observed IP address. Channel slowmode and limits specific to messages or concurrent connections apply independently.

The initial API 3 history window can include the last retained position visible to the caller. Client uses it to open near the latest messages. When the field is absent, Client can still start reading at the first permitted position. Voice moderation choices can advertise a one-time disconnect. The action checks `voice.move` and the role hierarchy in the source channel. The participant may rejoin if they still have channel access.

Moving uncategorized text and voice channels within one list uses `MixedOrder` in the signed API 3 policy request and layout basis version 3. Update the server and client together for mixed ordering. Earlier layout receipts and policy records retain their original grouping and remain verifiable.

`protectedVoiceControls` advertises the API 3 voice roster, call telemetry and server-wide moderation. The roster includes only active participants in voice channels visible to the caller. Telemetry is limited to the current call and expires in memory. Update all clients before applying server-wide voice restrictions: they add a signed `Mode: "server"` transition that older clients cannot replay.

`protectedVoiceChannelControls` enables one-time channel mute and deafen commands for updated clients. A participant can undo them with their ordinary audio controls. Previously saved channel restrictions can still be lifted through the moderation menu. Update all clients before an administrator restricts the owner or an owner or administrator lifts their own server-wide restriction. Those signed transitions use the updated authorization rules. The optional `protectedVoiceEvents` capability enables scoped voice refresh hints on connections opened with `&voice=1`. Existing clients continue polling. With `protectedVoiceMediaDeafen`, updated clients sign server deafen as `server-media`. LiveKit blocks the participant from publishing and subscribing while the participant keeps their verified voice key. Neither server mute nor media-only deafen rotates a valid key if the verified recipients stay the same. Earlier signed deafen operations remain readable and keep their key-exclusion semantics until lifted. Update all clients before applying media-only deafen.

`protectedComposerEvents` enables typing and voice recording indicators on streams opened with `&composer=1`. Clients publish a short-lived activity for a text channel via `PUT /api/v3/composer/{channel}`. Server checks sending permissions and relays the channel, sender profile ID and activity only to readers of that channel. Clients expire the status locally. The feature requires updated Client and Server.

API 3 audit entries can include display names for participants, resources and role assignments. Nickname-edit entries omit the target display name. The client uses names when available and a localized object type otherwise. Signed order proof verification still uses internal identifiers.

On migrated API 3 servers, roster reads can request encrypted legacy profile avatars with `legacyAvatars=1`. The Server returns avatars only for members visible in that roster. The Client decrypts them with the legacy room key retained on the migrated device. Older Servers omit the field. Devices without the key show initials.

With `protectedMemberProfileAvatars`, an author who can list server members can encrypt their profile avatar for active member devices using `shared=members`. `profileAvatars=all` returns packages only for profiles visible in the caller’s roster and only to their intended device. Older clients continue to use the owner-only roster option. An updated client can republish an existing avatar when it can decrypt it and the server reports missing packages.

Updated API 3 Server advertises `protectedDeviceRevocation` and `protectedProfileAvatar`. The first enables the existing signed `device.revoke` operation through the runtime policy routes. Updated Clients expose it for the owner and Administrator and leave earlier Clients' access unchanged. The second adds encrypted, revisioned avatar storage with packages for the current profile's devices. As new devices are linked, a device that can decrypt the current avatar republishes it for the updated device list. Upgrade Server and Client to enable these features. Existing databases gain additive avatar tables.

Delegated role and personal ACL edits require Client and Server support for the corresponding signed v10 actions. With server deafen still active, updated API 3 Clients and Servers support reconnect with a media grant that carries no key or audio permissions.

API 3 role delegation can read an action-scoped basis at `GET /api/v3/roles/scoped` and validate a proposed change at `POST /api/v3/roles/scoped/preview`. Assignment reads bind to a target from the caller's text-channel roster or authorized server directory. Definition reads expose only the editable part of the role order. Preview is tied to the current revision and includes aggregate effects for channels visible to the caller. `POST /api/v3/roles/scoped/commit` accepts a device signature over the exact change and returns a compact server-signed receipt. Full policy replay requires Client support for the signed `roles.scoped` action. The existing `roles.update` route is available to the owner and Administrator.

API 3 uses `PROTECTED_DEVICE_REVOKED` for a revoked device on an active profile after a valid session or signed login attempt. Update the Server and Client to show the unlink notice and remove the disconnected server from that device's list.
After an explicit profile unlink, updated Server returns `PROTECTED_PROFILE_UNLINKED` for the detached device's signed login attempt. Updated Client removes the server from that device's list and offers to join with a new invitation.

API 3 clients without a current policy attestation request `transition=1` with a scoped rotation claim. Updated Server reserves the lease only when it can supply transition evidence and the required attestations are available. Update Client and Server together to avoid unnecessary lease waits during membership changes.

With `protectedOwnerProfileAvatar`, the owner's Client republishes an existing profile avatar for active member devices. A Client can receive the encrypted image and its own key package when the owner is visible in the requested roster. Update Server and Client, then connect from a device that can open the owner's current avatar to publish the missing packages.
