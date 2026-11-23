# PawTalk protected access · Приёмка защищённого доступа

[Карта реализации](../decisions/012-protected-access.ru.md) · [Implementation map](../decisions/012-protected-access.en.md)

Идентификаторы соответствуют всем 111 строкам `verification.json` из согласованного handoff. Tests in the table identify the executable evidence. A partial result leaves the criterion open.

| Status | Состояние | Meaning |
| --- | --- | --- |
| Tested | Проверен в указанной среде | Exercised in the stated environment |
| Partial | Проверена только часть сценария | Some of the required assertions or environments remain open |
| Manual | Требуется отдельная ручная проверка | Manual acceptance remains open |
| Unavailable | Требуемая среда недоступна локально | Required environment is unavailable locally |

Проверки Go запускаются в `apps/server`. Имена Go-тестов в таблице пригодны для `go test ./... -run '<имя>' -count=1 -v`. Paths and commands below are relative to the repository root unless stated otherwise.

- **Go / Node.** `go test ./... -count=1` in `apps/server` and `npm test` from the root cover SQLite, policy vectors, pinned TLS fixtures and IPC tests. The default Go run skips opt-in load cases.
- **Electron UI.** `node apps/client/windows/scripts/server-chat-ui-smoke.mjs apps/client/windows/tests/<scenario>.cjs` runs the indicated renderer test in Electron with synthetic IPC.
- **Native Windows.** `node apps/client/windows/scripts/protected-selfhost-smoke.mjs <scenario> <built-api.exe> <livekit-server.exe>`. The implementation map records the corresponding native runs. Media cases that require a real local LiveKit connection use `PAWTALK_TEST_PROTECTED_MEDIA=1` with synthetic audio.
- **Load.** `PAWTALK_TEST_ARCHIVE_SCALE=1 go test . -run '^TestProtectedArchiveFullHistoryInvitationWorkBound$' -count=1 -v` and `PAWTALK_TEST_PROTECTED_FANOUT=1 go test . -run '^TestProtectedRoleFanoutAndConcurrentSends$' -count=1 -v`. Measurements and limits are in [the implementation map](../decisions/012-protected-access.en.md).
- **Manager.** The native Windows migration scenario uses Job Objects and a simulated SCM. The Linux migration scenario uses real Compose. These runs have different acceptance coverage from a real Windows service.

## Hidden channel contract · Контракт скрытого канала

For a signed-in caller without channel access, an existing hidden channel and an unknown valid channel ID produce the same HTTP 403 with `PROTECTED_ACCESS_DENIED`. This applies to reorder authority and submissions that use the channel as an anchor, live and imported history reads, history windows, polls, pins and attachment downloads. Search and gallery process authorized history in the Client. The state projection and rotation queue omit hidden channels.

Запросы участника без доступа к каналу возвращают одинаковый HTTP 403 с кодом `PROTECTED_ACCESS_DENIED` для существующего скрытого канала и корректного неизвестного ID. Это касается получения прав на перестановку и попытки использовать скрытый канал как опорный, чтения новой и перенесённой истории, окна истории, опросов, закреплений и скачивания вложений. Поиск и галерея обрабатывают доступную историю в Client. В состоянии и очереди ротации скрытый канал отсутствует.

## Latest local results · Последние локальные проверки

- Linux (Docker with Node and networking disabled): the full Server race and vet run passed earlier during integration. The latest focused race run passed `TestProtectedMigrationHistoryTLSClient`, `TestProtectedMigrationMaintenanceFullDiskRollsBack` and `TestProtectedMigrationFreezeSurvivesProcessCrash`.
- Windows: `go test ./... -count=1` and `go vet ./...` passed for Server. The Client build passed with Vite's chunk-size warning. The protected-channel Electron suite passed in Russian and English. The root `npm test` suite passed all 411 tests.
- Manager: `go test ./...` and `go vet ./...` passed for `apps/manager/windows/service`. The Windows handoff Python suite passed nine tests. Actual Windows SCM, physical microphones and independent external networks remain separate acceptance environments.

## Criteria · Критерии

| ID | Status | Evidence and remaining coverage · Проверка и остаток |
| --- | --- | --- |
| AUTH-01 | Tested | `protected-access.test.mjs` and Go policy vectors. Role allow wins independently of order. |
| AUTH-02 | Tested | `protected-access.test.mjs`, `TestProtectedChannelACLPersonalScopeAndRetry`, `TestProtectedTimeoutRuntime`. |
| AUTH-03 | Tested | `TestProtectedScopedRoleReadsAndPreviewTLS` and `TestProtectedChannelLifecycleAndDirectoryTLS`. Separate role read/write paths and permissions. |
| AUTH-04 | Tested | Go rank vectors and `TestProtectedNicknamesTLS` for an important action against equal and higher ranks. |
| AUTH-05 | Tested | `protected-access.test.mjs`, `TestRoleChange` and `protected-role-impact-ui.cjs`. Administrator grants and hierarchy are independent. |
| AUTH-06 | Tested | Go policy vectors and `TestProtectedVoiceRestrictionSessionAuthority`. Owner protection and capacity apply to Administrator. |
| AUTH-07 | Tested | `TestProtectedScopedRoleReadsAndPreviewTLS` rejects rank-class edits at the request schema. |
| AUTH-08 | Tested | `TestRoleChange` and `protected-access.test.mjs`. Evaluate the effective result of a role change. |
| AUTH-09 | Tested | `TestRoleChange`, `protected-access.test.mjs` and `TestProtectedScopedRoleReadsAndPreviewTLS`. |
| AUTH-10 | Tested | Go and JS policy vectors for lifting restrictions, plus `TestProtectedVoiceRestrictionSessionAuthority`. |
| AUTH-11 | Tested | `TestProtectedTimeoutRuntime` and `TestProtectedProfileLinkHTTP`. |
| AUTH-12 | Tested | `TestProtectedParticipationAndPollPermissionsTLS` and `TestProtectedChannelLifecycleAndDirectoryTLS`. |
| AUTH-13 | Tested | `TestProtectedMigrationPolicyPreservesEffectiveLegacyGrants` and the new-room policy vectors. |
| AUTH-14 | Tested | `TestPolicyConcurrentCommits`, `TestProtectedScopedRoleReadsAndPreviewTLS` and `protected-channel-ui.cjs`. |
| AUTH-15 | Tested | `TestRecoveryRejectionIsAtomic` and native `--policy-bulk-administrator`. |
| AUTH-16 | Tested | Go admission and role vectors and native `--policy-administrator`. |
| CHAN-01 | Tested | `TestProtectedChannelLifecycleAndDirectoryTLS`. Mixed category, uncategorized channels and rejected nesting. |
| CHAN-02 | Tested | Native `--protected-channel-lifecycle`. ACL detachment and explicit resynchronization. |
| CHAN-03 | Tested | `protected-channel-ui.cjs` and native `--protected-channel-lifecycle`. Drag, explicit selection and preview. |
| CHAN-04 | Tested | Native `--protected-channel-lifecycle`. Keep children, permissions and original pinned history. |
| CHAN-05 | Tested | `TestProtectedChannelLifecycleAndDirectoryTLS`. |
| CHAN-06 | Tested | `TestProtectedChannelLifecycleAndDirectoryTLS` and `protected-channel-ui.cjs`. |
| CHAN-07 | Tested | `TestProtectedHiddenChannelReadContractTLS` compares existing hidden and absent IDs, checks the signed reorder request, verifies an owner can read the fixtures and confirms task and directory filtering. Search and gallery use the history routes covered by the test. |
| CHAN-08 | Tested | `TestProtectedScopedChannelSettings` and `protected-channel-ui.cjs`. |
| CHAN-09 | Tested | Native `--protected-channel-lifecycle`. New channel IDs and epochs, preserved ACLs and empty history. |
| CHAN-10 | Tested | `TestProtectedChannelLifecycleAndDirectoryTLS` and `TestRosterScopesMembersAndRanksRolesAcrossPages`. |
| CHAN-11 | Tested | `TestProtectedChannelLifecycleAndDirectoryTLS`. Directory-only grant. |
| CHAN-12 | Tested | `TestProtectedRuntimeWebSocketFiltersQueuedEventsAfterRevoke`, `TestProtectedWebSocketDropsQueuedChannelOnRevoke` and `TestProtectedHTTPRevocationOrdersHistoryAndDerivedReads`. |
| HIST-01 | Tested | `TestAdmissionHistory` and `TestProtectedArchiveClientResumesHistoryThroughServer`. |
| HIST-02 | Tested | `TestAdmissionHistory` and `TestProtectedHTTPRevocationOrdersHistoryAndDerivedReads`. |
| HIST-03 | Tested | `TestAdmissionHistory`, `TestProtectedArchiveClientResumesHistoryThroughServer` and native `--scoped-invite-full-offline`. |
| HIST-04 | Tested | `protected-channel-ui.cjs` and the native archive-rotation and scoped-role-assignment cases in the implementation map. |
| HIST-05 | Tested | `TestProtectedArchiveClientResumesHistoryThroughServer`, `TestProtectedMigrationHistoryTLSClient` and `TestProtectedHiddenChannelReadContractTLS` cover source access, references, pins and poster delivery. In Russian and English, `protected-channel-ui.cjs` keeps the permitted reply, clears the quote, pin and thumbnail, then verifies that opening the hidden channel by ID reveals neither its title nor its contents. |
| HIST-06 | Tested | Native `--scoped-revision-role-deny-offline` and `TestProtectedScopedRevisionGroupedAudience`. |
| HIST-07 | Tested | `TestProtectedArchiveClientResumesHistoryThroughServer` and `protected-channel-ui.cjs`. |
| HIST-08 | Tested | `protected-channel-ui.cjs` and `TestProtectedHTTPRevocationOrdersHistoryAndDerivedReads`. Draft, quote and renewed access boundaries. |
| HIST-09 | Tested | `protected-channel-ui.cjs`. Offline message, retained own draft and purge on reconnect. |
| CHAT-01 | Tested | `TestProtectedParticipationAndPollPermissionsTLS`. |
| CHAT-02 | Tested | `TestProtectedParticipationAndPollPermissionsTLS`. Moderation and author checks. |
| CHAT-03 | Tested | `TestProtectedParticipationAndPollPermissionsTLS`. |
| CHAT-04 | Tested | `TestProtectedParticipationAndPollPermissionsTLS` and `TestProtectedImportedPollVotingAndDeletion`. |
| CHAT-05 | Tested | Native `--protected-pin-scope` and `protected-channel-ui.cjs`. |
| CHAT-06 | Tested | Native `--protected-attachment-scope` with synthetic audio. |
| CHAT-07 | Tested | Native `--protected-attachment-scope` and `TestProtectedAttachmentTransactions`. |
| CHAT-08 | Tested | `TestProtectedPollResultTasksWaitForRotationAndRespectHistory` and native `--protected-poll-publication`. |
| CHAT-09 | Tested | `TestProtectedPollResultTasksWaitForRotationAndRespectHistory` and `protected-channel-ui.cjs`. |
| CHAT-10 | Tested | `TestProtectedBanCleanupKeepsBanAndRollsBackPartialDeletion`. |
| CHAT-11 | Tested | `TestProtectedStorageQuotaPreservesArchiveAndPollPair`. |
| CHAT-12 | Tested | `TestProtectedMentionsAuthorizeAtMessageCommit` and native `--protected-mentions`. |
| CHAT-13 | Tested | Native `--protected-mentions`, synthetic notification requests. |
| MOD-01 | Tested | `TestProtectedTimeoutRuntime` and `TestProtectedParticipationAndPollPermissionsTLS`. |
| MOD-02 | Tested | `TestProtectedTimeoutRuntime`, `TestProtectedScopedChannelSettings` and `protected-channel-ui.cjs`. |
| MOD-03 | Tested | `TestProtectedSlowmodeAcrossLinkedDevicesAndRestart` and `TestProtectedProfileLinkHTTP`. |
| MOD-04 | Tested | `TestProtectedTimeoutRuntime` with a restarted service handler and SQLite. |
| MOD-05 | Tested | `TestProtectedBanCleanupKeepsBanAndRollsBackPartialDeletion` and native `--voice-moderation`. |
| MOD-06 | Tested | `TestProtectedProfileLinkHTTP` and native `--device-recovery`. |
| VOICE-01 | Tested | `PAWTALK_TEST_PROTECTED_MEDIA=1 go test . -run '^TestProtectedVoiceAdmissionAndGrant$' -count=1 -v` passed with local Windows LiveKit and Electron. Connect without Speak allows listening and denies a synthetic microphone publication. Server mute removes an active publication. A different bound device and media session reconnect to the same effective profile and LiveKit still refuses publication. `TestProtectedVoiceRestrictionSessionAuthority` covers scoped authority and native `--voice-moderation` covers E2EE media. Physical devices and external networks are tracked in VOICE-07. |
| VOICE-02 | Tested | Native `--voice-deafen-sustained`, `--voice-deafen-rejoin` and `--voice-moderation`, synthetic media. |
| VOICE-03 | Tested | `TestProtectedVoiceMove` and native `--voice-move`. |
| VOICE-04 | Tested | Native `--voice-move`. Receiver and local mute/PTT, no active microphone publication in the destination. |
| VOICE-05 | Tested | `TestProtectedVoiceRestrictionSessionAuthority`. Owner and Administrator both need a slot and can join after an explicit capacity change. |
| VOICE-06 | Tested | `TestProtectedVoiceSignalRechecksGrant`, native `--voice-ban-active` and `--voice-moderation`. Limits are in the implementation map. |
| VOICE-07 | Unavailable | Two physical microphones and devices on independent external networks. Local synthetic LiveKit results are recorded under VOICE-01–06. |
| INVITE-01 | Tested | `TestProtectedInviteManagement` and `protected-channel-ui.cjs`. |
| INVITE-02 | Tested | `TestProtectedScopedInviteReceipt` and `protected-channel-ui.cjs`. |
| INVITE-03 | Tested | `TestProtectedScopedInviteReceipt` verifies active membership after expiry; `TestProtectedInviteRedemptionBindsIdentityAndConsumesOnce` opens an ordinary session after revocation of the accepted invite. `TestProtectedProfileLinkHTTP` and native readmission runs cover renewed admission. |
| INVITE-04 | Tested | Native `--scoped-invite-offline` and `--scoped-invite-full-offline`. |
| KEY-01 | Tested | `TestProtectedArchiveClientResumesHistoryThroughServer`, protected archive key and link vectors. |
| KEY-02 | Tested | Native `--scoped-revision-role-deny-offline` and the protected text revision vectors. |
| KEY-03 | Tested | `TestProtectedEpochGraceIsEnforcedOnAppend` and `protected-text-status.test.mjs`. |
| KEY-04 | Tested | `TestProtectedOverlappingEpochRevocationsAcrossRestart`. Two revocations during overlapping grace windows persist across SQLite reopen. Both original deadlines hold, and the third generation eliminates the first immediately. |
| KEY-05 | Tested | `TestProtectedArchiveClientResumesHistoryThroughServer` and the documented previous-key grace boundary. |
| KEY-06 | Tested | `TestPolicyConcurrentCommits`, `TestProtectedEpochRejectsTamperingAndConcurrentRotations`, `TestProtectedScopedRoleReadsAndPreviewTLS`. |
| KEY-07 | Tested | `TestProtectedLimitedReaderRotatesLiveWhileArchivePending` and native `--scoped-role-assignment-offline`. |
| KEY-08 | Tested | `TestProtectedRotationLeaseFallbackAndExactRecipientManifest` and `TestProtectedProofClaimContinuationDoesNotRenewLease`. |
| KEY-09 | Tested | `TestProtectedArchiveClientResumesHistoryThroughServer` and native `--scoped-invite-batch-prefix-offline`. |
| KEY-10 | Tested | Native `--key-bulk-channel-readiness`. One 20-channel policy change, 18 ready packages and two pending. |
| KEY-11 | Tested | Native `--text-protection-status` waits for the actual old-key cutoff, resumes when a verified fresh key arrives, and checks one durable receipt across retries. Electron `protected-text-status-ui.cjs` verifies continued typing, explicit queuing, automatic submission and retained text on readmission. `TestProtectedDeferredSendRequiresContinuousAdmission` verifies the atomic admission check and receipt reuse. |
| KEY-12 | Tested | Native `--message-retry` and `TestProtectedArchiveClientResumesHistoryThroughServer`. |
| KEY-13 | Tested | `TestProtectedHPKEPackageDelivery`, `TestProtectedEpochRejectsTamperingAndConcurrentRotations` and native offline scoped rotation variants. |
| KEY-14 | Tested | `TestProtectedMigrationHistoryTLSClient` and `protected-scope-attestation.test.mjs`. |
| KEY-15 | Tested | `TestProtectedArchiveClientResumesHistoryThroughServer`, `TestProtectedAttachmentMessageFrameMatchesClient` and `protected-text-revision.test.mjs`. |
| KEY-16 | Tested | Prior opt-in `TestProtectedArchiveFullHistoryInvitationWorkBound` run. 10,000 generations and separate timing for inviter and reader. |
| KEY-17 | Tested | Prior opt-in `TestProtectedArchiveFullHistoryInvitationWorkBound` run and `protected-archive-resume.test.mjs`. |
| KEY-18 | Tested | Prior opt-in `TestProtectedRoleFanoutAndConcurrentSends` run with 240 synthetic devices across 12 channels. |
| DEVICE-01 | Tested | `TestProtectedProfileLinkHTTP`, `TestProtectedImportedProfileCanReadmitAfterUnlink` and native `--profile-linking`. |
| DEVICE-02 | Tested | `TestProtectedProfileLinkHTTP` and `TestCommitProfileLinkingBindsBothConsentsAndRotatesOnUnlink`. |
| DEVICE-03 | Tested | Native `--device-binding`, `--device-recovery` and `TestRecoveryDeviceTransitionKeepsCurrentAccess`. |
| DEVICE-04 | Tested | Native `--device-recovery`, including revoked admin role and ban. |
| DEVICE-05 | Tested | Native `--recovery-replacement` and recovery transaction tests. |
| DEVICE-06 | Tested | Native `--policy-bulk-administrator` and `TestRecoveryRejectionIsAtomic`. |
| DEVICE-07 | Tested | Native `--owner-transfer` and `--owner-transfer-recovery`, plus ownership confirmation UI. |
| UI-01 | Tested | `protected-text-status-ui.cjs` verifies all four states, focus, hover, click and blocked send in Russian and English in Electron. Manual Windows browser review of the same Client renderer with a grayscale display verified all four labels in both languages, distinct icons with an independently empty key queue, a tooltip on Tab focus and pointer hover, details opened by click and dismissed by Escape, and the retained draft with Send disabled. The paused explanation says verification failed and the draft was kept. |
| UI-02 | Tested | `protected-text-status-ui.cjs`, `protected-text-status.test.mjs` and native `--text-protection-status`. |
| UI-03 | Tested | `TestVisibleRotationQueueCountsCurrentTasksAcrossRestart` and `protected-rotation-queue-ui.cjs`. |
| UI-04 | Tested | `protected-channel-ui.cjs`, `protected-role-impact-ui.cjs` and `TestRosterScopesMembersAndRanksRolesAcrossPages`. |
| UI-05 | Tested | `membership-ipc.test.mjs`, `protected-role-impact-ui.cjs` and `protected-channel-ui.cjs`. |
| UI-06 | Tested | In Russian and English, `protected-channel-ui.cjs` verifies the timeout presets, custom bounds and reasons, retention of typed text after invalid input, server and text-channel notification mutes, and form spacing and action alignment. `protected-nickname-ui.cjs` verifies that a conflicting update leaves the typed name in the editor. |
| AUDIT-01 | Tested | `TestAuditScopesRetentionAndIndependentPolicyProofs`, `TestAuditChannelACLRecordsScopedRuleChanges` and `TestProtectedAuditContentMinimizationAcrossTLSAndSQLite`. |
| AUDIT-02 | Tested | `TestAuditScopesRetentionAndIndependentPolicyProofs` and `TestProtectedAuditPruneKeepsMigrationKeyMaterial`. |
| AUDIT-03 | Tested | `TestProtectedAuditContentMinimizationAcrossTLSAndSQLite`. Synthetic content, keys and names checked across boundaries. |
| MIG-01 | Tested | `TestProtectedMigrationPolicyPreservesEffectiveLegacyGrants` and `TestProtectedMigrationHistoryTLSClient`. |
| MIG-02 | Tested | `TestProtectedMigrationInspectsConfirmedOwnerOrder`. |
| MIG-03 | Tested | `TestProtectedMigrationMaintenanceFencesLegacyWriters` and `TestProtectedMigrationHistoryTLSClient`. |
| MIG-04 | Tested | `TestProtectedMigrationFreezeSurvivesProcessCrash` kills a process with a staged freeze and reopens the journal. `TestProtectedMigrationMaintenanceFullDiskRollsBack` and `TestProtectedMigrationHistoryTLSClient` trigger SQLite `SQLITE_FULL` at freeze, attachment import and activation. The tests verify that the original backup or approved checkpoint remains usable, partial progress stays incomplete and retry succeeds. TLS also covers lost responses and a reopened import. |
| MIG-05 | Tested | `TestProtectedMigrationHistoryTLSClient`. More recent Client checkpoint blocks sends to an older server copy. |
| MIG-06 | Tested | `TestProtectedMigrationHistoryTLSClient`, Windows Manager Electron smoke and Linux Manager TUI tests. |
| MIG-07 | Tested | Native `--protected-channel-lifecycle` and `protected-channel-ui.cjs`. Explicit confirmation and retained ciphertext. |
| MIG-08 | Partial | Linux Compose and Windows console/Job Object migration runs are recorded in the implementation map. From an Administrator shell, run `node apps/manager/windows/scripts/windows-manager-smoke.mjs --scm --protected-migration` for signed cutover and `node apps/manager/windows/scripts/windows-manager-smoke.mjs --scm --protected-migration-prepare` for preparation, restart and rollback. Use the candidate Server ZIP and Manager stage. The respective pass markers start with `PASS Windows SCM: signed API 3 cutover` and `PASS Windows SCM: read-only migration check`. |
| SCOPE-01 | Tested | The 26 included and 26 excluded decisions are checked below. D04 includes native avatar delivery and recovery and TLS migration. D17/D31 verify the retained preview, VAD and PTT behavior. Environment-specific voice acceptance is tracked under the VOICE scenarios. |
| SCOPE-02 | Tested | Verified production manifests, lockfiles, AGPL and third-party notices against `HEAD`. Bilingual user guides, architecture, security and compatibility describe API 3 as development work. The command results and environment limits are recorded here. No push, merge, tag or release occurred. |

## Original permission matrix · Исходная матрица полномочий

Mappings use the existing PawTalk catalog. Some source permissions expand into several PawTalk grants. The tests above provide evidence for the underlying actions.

| ID | Registered grants or implementation | Evidence |
| --- | --- | --- |
| D01 | `channel.view` | AUTH-01–02, CHAN-07, CHAN-10 |
| D02 | `channel.create`, `channel.edit`, `channel.delete` | CHAN-01–09 |
| D03 | `role.edit`, `role.assign`, `channel.access.edit` | AUTH-03–04, UI-04–05 |
| D04 | `server.edit` | `TestProtectedCommunityNameTLS`, `TestProtectedCommunityAvatarTLS`, `TestCommunityAvatarPacketClientInterop`, native `--community-avatar`, native `--avatar-recovery` and `TestProtectedMigrationHistoryTLSClient`. Client verifies recipient and publisher proofs. Electron covers the editor and sidebar. Native tests deliver the key to a later member and restore it to a replacement device after the sole owner's device is revoked. Migration re-encrypts the old avatar in the owner Client. |
| D05 | `audit.view` | AUDIT-01–03 |
| D07 | `invite.create` with separate `invite.view-all` and `invite.manage-all` | INVITE-01–04 |
| D08 | `member.kick` | MOD-05, CHAT-10 |
| D09 | `member.ban` | MOD-05–06, CHAT-10 |
| D10 | `profile.edit-self` | `TestProtectedNicknamesTLS`, `protected-nickname-ui.cjs` |
| D11 | `profile.edit-other` | `TestProtectedNicknamesTLS`, `protected-nickname-ui.cjs` |
| D12 | `member.timeout` | MOD-01–06 |
| D13 | `server.administrator` | AUTH-05–06, AUTH-15–16, UI-04 |
| D14 | `message.send` | CHAT-01–03, MOD-01, KEY-03 |
| D15 | `history.full` | HIST-01–09, KEY-01–02 |
| D16 | `message.delete-other` | CHAT-02 |
| D18 | `message.attach` | CHAT-06–07 |
| D20 | `mention.mass`, `mention.any-role` | CHAT-12–13 |
| D22 | `message.voice` | CHAT-06–07 |
| D23 | `poll.create` with separate participation and moderation grants | CHAT-03–04, CHAT-08–09 |
| D24 | `message.pin` | CHAT-05 |
| D25 | `message.slowmode.bypass` | MOD-03 |
| D26 | `voice.connect` | VOICE-01–07 |
| D27 | `voice.speak` | VOICE-01, VOICE-04 |
| D28 | `voice.mute` | VOICE-01–02, VOICE-06 |
| D29 | `voice.deafen` | VOICE-02 |
| D30 | `voice.move` | VOICE-03–04 |

Исключённые строки сверены с [каталогом ролей](../../apps/server/internal/access/catalog.json). Excluded rows were checked against the permission catalog. D17 and D31 retain client features.

| IDs | Scope · Область |
| --- | --- |
| D06, D52 | Insights and creator monetization |
| D17 | Client link/GIF and composer preview. `chat-format.test.mjs`, `protected-channel-ui.cjs`, `external-links-smoke.mjs`. |
| D19, D21 | Reactions and TTS |
| D31 | Client VAD and PTT. `gate.test.mjs`, `rnnoise.test.mjs`, `worklet.test.mjs`. |
| D32, D33, D34, D35, D36, D37 | Priority speaker, streaming, voice status, soundboards, external sounds and requests to speak |
| D38, D39, D40, D41, D42 | Webhooks, expressions, external emoji and stickers |
| D43, D44, D45 | Application commands, embedded activities and external apps |
| D46, D47 | Events |
| D48, D49, D50, D51 | Threads |

## Manual acceptance · Ручная приёмка

**VOICE-07.** Use an isolated protected room and two Windows Clients with physical microphones on different external networks. Record Client, Server and LiveKit builds, network types and input devices. Confirm two-way audio, use both VAD and a held PTT key, reconnect after a network interruption and use the server mute/deafen controls. Time the end of audible media and the return of audio after a fresh grant. Save diagnostics with live invites, tokens and personal data removed.

**VOICE-07.** Используйте отдельную защищённую комнату и два Windows Client с физическими микрофонами в разных внешних сетях. Зафиксируйте сборки Client, Server и LiveKit, типы сетей и устройства ввода. Проверьте звук в обе стороны, VAD и удержание PTT, переподключение после обрыва, серверные mute и deafen. Измерьте момент прекращения слышимого звука и его возврата после новой выдачи допуска. Сохраните диагностику без действующих приглашений, токенов и персональных данных.
