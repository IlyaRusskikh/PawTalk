package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) handler() http.Handler {
	return p.handlerWithVoice(config{}, nil)
}

func (p *protectedRuntime) handlerWithVoice(cfg config, upstream *url.URL) http.Handler {
	limiter := newProtectedRequestLimiter(p.store)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", limiter.public.limited(p.configHTTP(upstream != nil)))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		respond(w, http.StatusOK, map[string]any{"status": "ok", "apiProtocolVersion": 3, "cutoverDigest": p.cutoverDigest})
	})
	mux.HandleFunc("GET /api/v3/session/challenge", limiter.public.limited(p.sessionChallengeHTTP))
	mux.HandleFunc("POST /api/v3/session/open", limiter.public.limited(p.openSessionHTTP))
	mux.HandleFunc("GET /api/v3/migration/runtime-recipient", limiter.public.limited(p.migratedRecipientHTTP))
	mux.HandleFunc("POST /api/v3/migration/runtime-recipient", limiter.public.limited(p.migratedRecipientHTTP))
	mux.HandleFunc("GET /api/v3/devices/self", limiter.limited(p.ownDevicesHTTP))
	mux.HandleFunc("POST /api/v3/devices/bind/challenge", limiter.limited(p.deviceBindingChallengeHTTP))
	mux.HandleFunc("POST /api/v3/devices/bind/apply", limiter.limited(p.deviceBindingApplyHTTP))
	mux.HandleFunc("GET /api/v3/devices/bind/result/{operation}", limiter.limited(p.deviceBindingResultHTTP))
	mux.HandleFunc("GET /api/v3/profiles/link/status", limiter.limited(p.profileLinkStatusHTTP))
	mux.HandleFunc("POST /api/v3/profiles/link/preview", limiter.limited(p.previewProfileLinkHTTP))
	mux.HandleFunc("POST /api/v3/profiles/link/apply", limiter.limited(p.applyProfileLinkHTTP))
	mux.HandleFunc("POST /api/v3/profiles/unlink/apply", limiter.limited(p.applyProfileUnlinkHTTP))
	mux.HandleFunc("GET /api/v3/profiles/{profile}/nickname", limiter.limited(p.readNicknameHTTP))
	mux.HandleFunc("PUT /api/v3/profiles/{profile}/nickname", limiter.limited(p.changeNicknameHTTP))
	mux.HandleFunc("GET /api/v3/profiles/self/avatar", limiter.limited(p.ownProfileAvatarHTTP))
	mux.HandleFunc("PUT /api/v3/profiles/self/avatar", limiter.limited(p.saveOwnProfileAvatarHTTP))
	mux.HandleFunc("GET /api/v3/profiles/self/avatar/audience", limiter.limited(p.profileAvatarAudienceHTTP))
	mux.HandleFunc("GET /api/v3/state", limiter.limited(p.stateHTTP))
	mux.HandleFunc("PUT /api/v3/community/name", limiter.limited(p.renameCommunityHTTP))
	mux.HandleFunc("GET /api/v3/community/avatar", limiter.limited(p.readCommunityAvatarHTTP))
	mux.HandleFunc("PUT /api/v3/community/avatar", limiter.limited(p.saveCommunityAvatarHTTP))
	mux.HandleFunc("GET /api/v3/community/avatar/audience", limiter.limited(p.communityAvatarAudienceHTTP))
	mux.HandleFunc("GET /api/v3/community/avatar/delivery", limiter.limited(p.pendingCommunityAvatarHTTP))
	mux.HandleFunc("PUT /api/v3/community/avatar/delivery", limiter.limited(p.deliverCommunityAvatarHTTP))
	mux.HandleFunc("GET /api/v3/community/avatar/recovery", limiter.limited(p.readCommunityAvatarRecoveryHTTP))
	mux.HandleFunc("PUT /api/v3/community/avatar/recovery", limiter.limited(p.recoverCommunityAvatarHTTP))
	if p.importedProfileNames != nil {
		mux.HandleFunc("GET /api/v3/community/avatar/legacy", limiter.limited(p.readLegacyCommunityAvatarHTTP))
	}
	mux.HandleFunc("GET /api/v3/events", limiter.limited(p.eventsHTTP))
	mux.HandleFunc("PUT /api/v3/composer/{channel}", limiter.limited(p.composerActivityHTTP))
	mux.HandleFunc("POST /api/v3/activity", limiter.limited(p.activityHTTP))
	mux.HandleFunc("GET /api/v3/member/leave/head", limiter.limited(p.departureHeadHTTP))
	mux.HandleFunc("POST /api/v3/member/leave", limiter.limited(p.departMemberHTTP))
	mux.HandleFunc("POST /api/v3/moderation/member/{action}", limiter.limited(p.moderateMembershipHTTP))
	mux.HandleFunc("POST /api/v3/moderation/cleanup/preview", limiter.limited(p.previewModerationCleanupHTTP))
	mux.HandleFunc("POST /api/v3/moderation/cleanup/apply", limiter.limited(p.applyModerationCleanupHTTP))
	mux.HandleFunc("POST /api/v3/recovery/challenge", limiter.limited(p.recoveryEnrollmentChallengeHTTP))
	mux.HandleFunc("POST /api/v3/recovery/enroll", limiter.limited(p.enrollRecoveryHTTP))
	mux.HandleFunc("POST /api/v3/recovery/confirmation-challenge", limiter.limited(p.recoveryConfirmationChallengeHTTP))
	mux.HandleFunc("POST /api/v3/recovery/confirm", limiter.limited(p.confirmRecoveryHTTP))
	mux.HandleFunc("POST /api/v3/recovery/device-challenge", limiter.public.limited(p.recoveryDeviceChallengeHTTP))
	mux.HandleFunc("POST /api/v3/recovery/device", limiter.public.limited(p.recoverDeviceHTTP))
	mux.HandleFunc("GET /api/v3/recovery/coverage", limiter.limited(p.recoveryCoverageHTTP))
	mux.HandleFunc("GET /api/v3/recovery/packages/{channel}/{purpose}", limiter.limited(p.recoveryPackageHTTP))
	mux.HandleFunc("GET /api/v3/recovery/packages/{channel}/admitted/{key}", limiter.limited(p.admittedRecoveryLivePackageHTTP))
	mux.HandleFunc("GET /api/v3/moderation/bans", limiter.limited(p.listMemberBansHTTP))
	mux.HandleFunc("GET /api/v3/invites", limiter.limited(p.listInvitesHTTP))
	mux.HandleFunc("POST /api/v3/invites", limiter.limited(p.createInviteHTTP))
	mux.HandleFunc("POST /api/v3/invites/redeem", limiter.public.limited(p.redeemInviteHTTP))
	mux.HandleFunc("GET /api/v3/invites/admissions/{device}", limiter.limited(p.inviteAdmissionEvidenceHTTP))
	mux.HandleFunc("POST /api/v3/invites/session/open", limiter.public.limited(p.openPendingInviteSessionHTTP))
	mux.HandleFunc("GET /api/v3/invites/session/state", limiter.public.limited(p.pendingInviteStateHTTP))
	mux.HandleFunc("DELETE /api/v3/invites/{invite}", limiter.limited(p.revokeInviteHTTP))
	mux.HandleFunc("GET /api/v3/audit", limiter.limited(p.readAuditHTTP))
	mux.HandleFunc("PUT /api/v3/audit/retention", limiter.limited(p.auditRetentionHTTP))
	mux.HandleFunc("GET /api/v3/roster/text/{channel}", limiter.limited(p.rosterHTTP))
	mux.HandleFunc("GET /api/v3/roster/members", limiter.limited(p.rosterHTTP))
	mux.HandleFunc("GET /api/v3/roster/voice", limiter.limited(p.rosterHTTP))
	mux.HandleFunc("GET /api/v3/moderation/timeout/{profile}", limiter.limited(p.readTimeoutHTTP))
	mux.HandleFunc("PUT /api/v3/moderation/timeout/{profile}", limiter.limited(p.changeTimeoutHTTP))
	mux.HandleFunc("GET /api/v3/history/imported/{channel}", limiter.limited(p.importedHistoryHTTP))
	mux.HandleFunc("POST /api/v3/history/imported/{channel}/references", limiter.limited(p.importedHistoryReferencesHTTP))
	mux.HandleFunc("GET /api/v3/history/imported/{channel}/link", limiter.limited(p.importedHistoryLinkHTTP))
	mux.HandleFunc("GET /api/v3/history/attachments/{channel}/{position}/{attachment}", limiter.limited(p.importedAttachmentHTTP))
	mux.HandleFunc("GET /api/v3/history/live-attachments/{channel}/{position}/{attachment}", limiter.limited(p.liveAttachmentHTTP))
	mux.HandleFunc("PUT /api/v3/history/live-attachments/{channel}/{attachment}", limiter.limited(p.putLiveAttachmentHTTP))
	mux.HandleFunc("GET /api/v3/history/window/{channel}", limiter.limited(p.historyWindowHTTP))
	mux.HandleFunc("GET /api/v3/history/pins/{channel}", limiter.limited(p.pinnedMessagesHTTP))
	mux.HandleFunc("PUT /api/v3/history/pins/{channel}/{position}", limiter.limited(p.setMessagePinHTTP))
	mux.HandleFunc("DELETE /api/v3/history/message/{channel}/{position}", limiter.limited(p.deleteMessageHTTP))
	mux.HandleFunc("DELETE /api/v3/history/poll/{channel}/{position}", limiter.limited(p.deleteCompletedPollHTTP))
	mux.HandleFunc("GET /api/v3/history/poll/{channel}/{position}", limiter.limited(p.pollHTTP))
	mux.HandleFunc("PUT /api/v3/history/poll/{channel}/{position}", limiter.limited(p.pollHTTP))
	mux.HandleFunc("PUT /api/v3/history/poll/{channel}/{position}/close", limiter.limited(p.closePollHTTP))
	mux.HandleFunc("GET /api/v3/history/checklist/{channel}/{position}", limiter.limited(p.checklistHTTP))
	mux.HandleFunc("PUT /api/v3/history/checklist/{channel}/{position}", limiter.limited(p.checklistHTTP))
	mux.HandleFunc("GET /api/v3/history/revision/{channel}/{position}/basis", limiter.limited(p.revisionBasisHTTP))
	mux.HandleFunc("GET /api/v3/history/revision/{channel}/{position}", limiter.limited(p.readRevisionHTTP))
	mux.HandleFunc("PUT /api/v3/history/revision/{channel}/{position}", limiter.limited(p.commitRevisionHTTP))
	mux.HandleFunc("GET /api/v3/keys/current/{channel}/{purpose}", limiter.limited(p.currentEpochPackageHTTP))
	mux.HandleFunc("GET /api/v3/protection/{channel}/window", limiter.limited(p.protectionWindowHTTP))
	mux.HandleFunc("GET /api/v3/keys/admitted/{channel}/{key}", limiter.limited(p.admittedLivePackageHTTP))
	mux.HandleFunc("GET /api/v3/keys/proofs/{channel}/{purpose}", limiter.limited(p.epochProofsHTTP))
	mux.HandleFunc("GET /api/v3/keys/archive/{channel}/links/{key}", limiter.limited(p.archiveLinksHTTP))
	mux.HandleFunc("GET /api/v3/keys/rotations", limiter.limited(p.pendingRotationsHTTP))
	mux.HandleFunc("POST /api/v3/keys/rotate/{channel}/{purpose}/claim", limiter.limited(p.claimRotationHTTP))
	mux.HandleFunc("POST /api/v3/keys/rotate/{channel}/targets", limiter.limited(p.rotationTargetsHTTP))
	mux.HandleFunc("POST /api/v3/keys/rotate/{channel}/recovery-targets", limiter.limited(p.rotationRecoveryTargetsHTTP))
	mux.HandleFunc("POST /api/v3/keys/rotate/{channel}/{purpose}/commit", limiter.limited(p.commitRotationHTTP))
	mux.HandleFunc("GET /api/v3/history/live/{channel}", limiter.limited(p.liveHistoryHTTP))
	mux.HandleFunc("GET /api/v3/history/poll-results/tasks", limiter.limited(p.pollResultTasksHTTP))
	mux.HandleFunc("POST /api/v3/history/poll-results/{channel}/{position}", limiter.limited(p.publishPollResultHTTP))
	mux.HandleFunc("POST /api/v3/history/live/{channel}", limiter.limited(p.appendLiveMessageHTTP))
	mux.HandleFunc("POST /api/v3/mentions/inbox", limiter.limited(p.mentionInboxHTTP))
	mux.HandleFunc("GET /api/v3/mentions/inbox/{channel}/{position}", limiter.limited(p.mentionEligibilityHTTP))
	mux.HandleFunc("POST /api/v3/policy/preview", limiter.limited(p.policyPreviewHTTP))
	mux.HandleFunc("POST /api/v3/policy/commit", limiter.limited(p.policyCommitHTTP))
	mux.HandleFunc("GET /api/v3/policy/proofs", limiter.limited(p.managementPolicyProofsHTTP))
	mux.HandleFunc("GET /api/v3/roles/scoped", limiter.limited(p.scopedRoleBasisHTTP))
	mux.HandleFunc("POST /api/v3/roles/scoped/preview", limiter.limited(p.scopedRolePreviewHTTP))
	mux.HandleFunc("POST /api/v3/roles/scoped/commit", limiter.limited(p.scopedRoleCommitHTTP))
	mux.HandleFunc("GET /api/v3/policy/scope-authority", limiter.limited(p.scopeAuthorityHTTP))
	mux.HandleFunc("POST /api/v3/policy/scope-authority/device", limiter.limited(p.acceptScopeDeviceHandoverHTTP))
	mux.HandleFunc("GET /api/v3/ownership/status", limiter.limited(p.ownershipStatusHTTP))
	mux.HandleFunc("GET /api/v3/ownership/offer", limiter.limited(p.ownershipReadHTTP))
	mux.HandleFunc("POST /api/v3/ownership/preview", limiter.limited(p.ownershipPreviewHTTP))
	mux.HandleFunc("POST /api/v3/ownership/offer", limiter.limited(p.ownershipOfferHTTP))
	mux.HandleFunc("POST /api/v3/ownership/accept", limiter.limited(p.ownershipAcceptHTTP))
	mux.HandleFunc("POST /api/v3/ownership/cancel", limiter.limited(p.ownershipCancelHTTP))
	mux.HandleFunc("GET /api/v3/policy/attestations/{revision}", limiter.limited(p.readPolicyAttestationHTTP))
	mux.HandleFunc("GET /api/v3/policy/attestations/pending", limiter.limited(p.pendingPolicyAttestationsHTTP))
	mux.HandleFunc("GET /api/v3/policy/channel-order/{channel}", limiter.limited(p.channelOrderAuthorityHTTP))
	mux.HandleFunc("GET /api/v3/policy/channel-acl/{channel}", limiter.limited(p.channelACLProofHTTP))
	mux.HandleFunc("POST /api/v3/policy/channel-acl/{channel}", limiter.limited(p.commitChannelACLRoleRulesHTTP))
	mux.HandleFunc("GET /api/v3/policy/channel-acl/{channel}/personal/{profile}", limiter.limited(p.channelACLPersonalHTTP))
	mux.HandleFunc("POST /api/v3/policy/channel-acl/{channel}/personal", limiter.limited(p.commitChannelACLPersonalHTTP))
	mux.HandleFunc("GET /api/v3/policy/channel-settings/{channel}", limiter.limited(p.channelSettingsProofHTTP))
	mux.HandleFunc("GET /api/v3/policy/channel-settings/{channel}/edit", limiter.limited(p.channelSettingsEditEvidenceHTTP))
	mux.HandleFunc("POST /api/v3/policy/channel-settings/{channel}", limiter.limited(p.commitChannelSettingsHTTP))
	mux.HandleFunc("GET /api/v3/policy/channel-order/{channel}/proof", limiter.limited(p.channelLayoutEvidenceHTTP))
	mux.HandleFunc("POST /api/v3/policy/channel-order", limiter.limited(p.commitChannelLayoutHTTP))
	mux.HandleFunc("POST /api/v3/policy/attestations", limiter.limited(p.commitPolicyAttestationHTTP))
	mux.HandleFunc("GET /api/v3/policy/text-channel/{channel}", limiter.limited(p.textChannelPolicyProofHTTP))
	mux.HandleFunc("POST /api/v3/voice/{channel}/prepare", limiter.limited(p.prepareVoiceSlotHTTP))
	mux.HandleFunc("POST /api/v3/voice/{channel}/key/claim", limiter.limited(p.claimVoiceKeyHTTP))
	mux.HandleFunc("POST /api/v3/voice/{channel}/key/heartbeat", limiter.limited(p.voiceKeyHeartbeatHTTP))
	mux.HandleFunc("PUT /api/v3/voice/{channel}/key", limiter.limited(p.publishVoiceKeyHTTP))
	mux.HandleFunc("GET /api/v3/voice/{channel}/key", limiter.limited(p.currentVoiceKeyHTTP))
	if upstream != nil {
		voice := &membershipAPI{store: p.store, cfg: cfg, voiceChanged: p.publishProtectedVoice}
		registerProtectedVoiceRoutes(mux, voice, limiter)
		media := membershipMediaHandler(p.store, cfg, upstream)
		mux.Handle("/rtc", media)
		mux.Handle("/rtc/", media)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.TLS == nil {
			memberFail(w, memberError(http.StatusUpgradeRequired, "TLS_REQUIRED"))
			return
		}
		if r.Method != http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v3/") {
			response := &eventResponse{ResponseWriter: w}
			mux.ServeHTTP(response, r)
			if response.status >= 200 && response.status < 300 {
				p.publishProtectedMutation(r)
			}
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (p *protectedRuntime) textChannelPolicyProofHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.ChannelRestricted)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchTextChannelPolicyProof(r.Context(),
		p.resolveSession(memberBearer(r)), channel, &p.textPolicyProofs, func(value access.TextChannelPolicyDisclosure) error {
			return writeProtectedDelivery(w, &sent, value)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) voiceKeyHeartbeatHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Epoch string `json:"epochId"`
	}
	if _, err := decodeMemberJSON(w, r, 128, &input); err != nil {
		memberFail(w, err)
		return
	}
	status, err := p.heartbeatVoiceKey(r.Context(), memberBearer(r), r.PathValue("channel"), input.Epoch)
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, status)
}

func (p *protectedRuntime) prepareVoiceSlotHTTP(w http.ResponseWriter, r *http.Request) {
	deafened, err := p.prepareVoiceSlot(r.Context(), memberBearer(r), r.PathValue("channel"))
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, struct {
		OK       bool `json:"ok"`
		Deafened bool `json:"deafened,omitempty"`
	}{true, deafened})
}

func (p *protectedRuntime) claimVoiceKeyHTTP(w http.ResponseWriter, r *http.Request) {
	claim, err := p.claimVoiceKey(r.Context(), memberBearer(r), r.PathValue("channel"))
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, claim)
}

func (p *protectedRuntime) publishVoiceKeyHTTP(w http.ResponseWriter, r *http.Request) {
	var offer protectedVoiceKeyOffer
	if _, err := decodeMemberJSON(w, r, 2*1024*1024, &offer); err != nil {
		memberFail(w, err)
		return
	}
	err := p.publishVoiceKey(r.Context(), memberBearer(r), r.PathValue("channel"), offer)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) currentVoiceKeyHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := p.dispatchVoiceKey(r.Context(), memberBearer(r), r.PathValue("channel"), func(delivery protectedVoiceKeyDelivery) error {
		return writeProtectedDelivery(w, &sent, delivery)
	})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) sessionChallengeHTTP(w http.ResponseWriter, _ *http.Request) {
	challenge, err := p.issueSessionChallenge()
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, challenge)
}

func (p *protectedRuntime) openSessionHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedSessionRequest
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	result, err := p.openSession(r.Context(), input)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusCreated, result)
}

func (p *protectedRuntime) stateHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchVisibleStateWithQuery(r.Context(), p.resolveSession(memberBearer(r)),
		func(query access.SessionQuery, view access.Projection) error {
			now := p.store.now()
			for i, channel := range view.Channels {
				if channel.Settings == nil {
					view.Channels[i].ImportedName = p.importedChannelNames[channel.ID]
				}
				if channel.VoiceParticipants == nil {
					continue
				}
				for j := range *channel.VoiceParticipants {
					participant := &(*channel.VoiceParticipants)[j]
					participant.SelfMuted, participant.SelfDeafened = p.store.voiceNetwork.audioStatus(channel.ID, participant.SessionID, now)
					name, err := protectedMemberNickname(r.Context(), query, participant.ProfileID)
					if err != nil {
						return err
					}
					participant.Name = name
				}
			}
			name, err := access.ReadCommunityName(r.Context(), query)
			if err != nil {
				return err
			}
			return writeProtectedDelivery(w, &sent, struct {
				access.Projection
				Community access.CommunityName `json:"community"`
			}{view, name})
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) rosterHTTP(w http.ResponseWriter, r *http.Request) {
	channel, after := r.PathValue("channel"), r.URL.Query().Get("after")
	var revision int64
	if channel != "" && !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	if r.URL.Query().Has("revision") || after != "" {
		var err error
		revision, err = strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
		if err != nil || revision <= 0 || revision > migrationMaxSafePosition || !validHexID(after, 64) {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
	}
	var sent bool
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	dispatch := store.DispatchRoster
	mentions := r.URL.Query().Get("mentions") == "1"
	legacyAvatars := !mentions && p.importedProfileNames != nil && r.URL.Query().Get("legacyAvatars") == "1"
	avatars := r.URL.Query().Get("profileAvatars")
	if r.Pattern == "GET /api/v3/roster/voice" {
		if mentions {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
		dispatch = func(ctx context.Context, resolve access.ResolveSession, _, after string, revision int64,
			deliver func(access.SessionQuery, access.RosterPage) error) error {
			return store.DispatchVoiceRoster(ctx, resolve, after, revision, avatars, deliver)
		}
	} else if mentions {
		dispatch = store.DispatchMentionRoster
	} else if avatars == "1" || avatars == "all" {
		dispatch = func(ctx context.Context, resolve access.ResolveSession, channel, after string, revision int64,
			deliver func(access.SessionQuery, access.RosterPage) error) error {
			return store.DispatchRosterWithAvatars(ctx, resolve, channel, after, revision, avatars, deliver)
		}
	}
	err := dispatch(r.Context(), p.resolveSession(memberBearer(r)),
		channel, after, revision, func(query access.SessionQuery, page access.RosterPage) error {
			if !mentions {
				p.presence.annotate(page.Members, p.store.now())
			}
			for i := range page.Members {
				member := &page.Members[i]
				name, err := protectedMemberNickname(r.Context(), query, member.ID)
				if err != nil {
					return err
				}
				member.Name = name
				if legacyAvatars && (member.ProfileAvatar == nil || member.ProfileAvatar.Pending) {
					var avatar access.RosterLegacyAvatar
					err := query.QueryRowContext(r.Context(), `SELECT avatar_envelope, COALESCE(avatar_profile_id, profile_id)
						FROM effective_profiles WHERE profile_id=? AND avatar_envelope IS NOT NULL
						AND length(avatar_envelope) BETWEEN 1 AND 24000`, member.ID).Scan(&avatar.Envelope, &avatar.Author)
					if err == nil {
						member.LegacyAvatar = &avatar
					} else if !errors.Is(err, sql.ErrNoRows) {
						return err
					}
				}
				for j := range member.Roles {
					role := &member.Roles[j]
					if role.Name == "" {
						role.Name = p.importedRoleNames[role.ID]
					}
				}
			}
			return writeProtectedDelivery(w, &sent, page)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func protectedHistoryWindow(r *http.Request) (uint64, int, error) {
	query := r.URL.Query()
	after, limit := uint64(0), uint64(32)
	var err error
	if query.Has("after") {
		after, err = strconv.ParseUint(query.Get("after"), 10, 64)
	}
	if err == nil && query.Has("limit") {
		limit, err = strconv.ParseUint(query.Get("limit"), 10, 64)
	}
	if err != nil || after >= uint64(migrationMaxSafePosition) || limit < 1 || limit > 32 {
		return 0, 0, memberError(http.StatusBadRequest, "INVALID_PROTECTED_HISTORY_PAGE")
	}
	return after, int(limit), nil
}

func (p *protectedRuntime) historyWindowHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var after *string
	if r.URL.Query().Has("after") {
		value := r.URL.Query().Get("after")
		if value != "" && !validHexID(value, 32) {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
		after = &value
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchHistoryWindow(r.Context(), p.resolveSession(memberBearer(r)),
		channel, after, p.importedProfileNames != nil, func(window access.HistoryWindow) error { return writeProtectedDelivery(w, &sent, window) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) pinnedMessagesHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	var before uint64
	var err error
	if value := r.URL.Query().Get("before"); value != "" {
		before, err = strconv.ParseUint(value, 10, 64)
	}
	if err != nil || before > uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchPinnedMessages(r.Context(), p.resolveSession(memberBearer(r)),
		channel, p.importedProfileNames != nil, before, func(page access.PinnedMessagesPage) error {
			return writeProtectedDelivery(w, &sent, page)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) setMessagePinHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	position, err := strconv.ParseUint(r.PathValue("position"), 10, 64)
	if err != nil || position == 0 || position >= uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var input struct {
		Pinned *bool `json:"pinned"`
	}
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	if input.Pinned == nil {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	err = access.NewStoreWithClock(p.store.db, p.store.now).SetMessagePin(r.Context(), p.resolveSession(memberBearer(r)),
		channel, position, *input.Pinned, p.importedProfileNames != nil)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) deleteMessageHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	position, err := strconv.ParseUint(r.PathValue("position"), 10, 64)
	if err != nil || position == 0 || position >= uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var imported access.ResolveImportedMessage
	if p.importedProfileNames != nil {
		imported = resolveImportedProtectedMessage
	}
	err = access.NewStoreWithClock(p.store.db, p.store.now).DeleteMessage(r.Context(),
		p.resolveSession(memberBearer(r)), imported, channel, position)
	if errors.Is(err, access.ErrMessageKind) {
		err = memberError(http.StatusConflict, "PROTECTED_MESSAGE_DELETION_RESTRICTED")
	}
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) deleteCompletedPollHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	position, err := strconv.ParseUint(r.PathValue("position"), 10, 64)
	if err != nil || position == 0 || position >= uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var imported access.ResolveCompletedPoll
	if p.importedProfileNames != nil {
		imported = resolveImportedCompletedPoll
	}
	err = access.NewStoreWithClock(p.store.db, p.store.now).DeleteCompletedPoll(r.Context(),
		p.resolveSession(memberBearer(r)), imported, channel, position)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) importedHistoryHTTP(w http.ResponseWriter, r *http.Request) {
	after, limit, err := protectedHistoryWindow(r)
	if err != nil {
		memberFail(w, err)
		return
	}
	var sent bool
	channel := r.PathValue("channel")
	resolve := p.resolveSession(memberBearer(r))
	if p.importedProfileNames == nil {
		if !validHexID(channel, 32) {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
		err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchHistory(r.Context(), resolve, channel,
			func(_ *sql.Conn, first, _ uint64) error {
				return writeProtectedDelivery(w, &sent, importedProtectedPage{First: first, Messages: []importedProtectedMessage{}})
			})
	} else {
		err = p.store.dispatchImportedProtectedHistory(r.Context(), resolve, channel, after, limit,
			func(page importedProtectedPage) error { return writeProtectedDelivery(w, &sent, page) })
	}
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) importedHistoryReferencesHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs []string `json:"ids"`
	}
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) || len(input.IDs) < 1 || len(input.IDs) > 32 {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	ids := make([]int64, 0, len(input.IDs))
	for _, value := range input.IDs {
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id < 1 || value != strconv.FormatInt(id, 10) {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
		ids = append(ids, id)
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchHistory(r.Context(), p.resolveSession(memberBearer(r)), channel,
		func(conn *sql.Conn, first, next uint64) error {
			references, err := readImportedMessageReferences(r.Context(), conn, channel, first, next, ids, p.importedProfileNames != nil)
			if err != nil {
				return err
			}
			return writeProtectedDelivery(w, &sent, references)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) currentEpochPackageHTTP(w http.ResponseWriter, r *http.Request) {
	channel, purpose := r.PathValue("channel"), r.PathValue("purpose")
	if !validHexID(channel, 32) || purpose != access.LiveEpoch && purpose != access.ArchiveEpoch {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	scoped := r.URL.Query().Get("scoped") == "1"
	proof, err := readProtectedProofRequest(r, scoped, false)
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchCurrentEpochPackage(r.Context(),
		p.resolveSession(memberBearer(r)), channel, purpose, verifyProtectedEpochSignature, &p.textPolicyProofs,
		scoped, signLiveRoleHistoryReceipt, func(delivery access.EpochPackageDelivery) error { return proof.write(w, &sent, delivery, "") })
	if err != nil && !sent {
		policyAttestationFail(w, proof.failure(err))
	}
}

func signLiveRoleHistoryReceipt(ctx context.Context, query access.SessionQuery, live access.EpochRecord, proof access.PolicyProof) ([]byte, error) {
	return signProtectedServerEvidence(ctx, query, proof.Draft.ResourceChange.RolesEdit.ServerKey,
		func(serverID string) ([]byte, error) {
			return access.LiveRoleHistoryReceiptFrame(serverID, live, proof)
		})
}

func (p *protectedRuntime) admittedLivePackageHTTP(w http.ResponseWriter, r *http.Request) {
	channel, key := r.PathValue("channel"), r.PathValue("key")
	if !validHexID(channel, 32) || !validHexID(key, 64) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	scoped := r.URL.Query().Get("scoped") == "1"
	proof, err := readProtectedProofRequest(r, scoped, false)
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchAdmittedLivePackage(r.Context(),
		p.resolveSession(memberBearer(r)), channel, key, verifyProtectedEpochSignature, &p.textPolicyProofs,
		scoped, func(delivery access.EpochPackageDelivery) error { return proof.write(w, &sent, delivery, "") })
	if err != nil && !sent {
		policyAttestationFail(w, proof.failure(err))
	}
}

func (p *protectedRuntime) admittedRecoveryLivePackageHTTP(w http.ResponseWriter, r *http.Request) {
	channel, key := r.PathValue("channel"), r.PathValue("key")
	if !validHexID(channel, 32) || !validHexID(key, 64) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchAdmittedRecoveryLivePackage(r.Context(),
		p.resolveSession(memberBearer(r)), channel, key, verifyProtectedEpochSignature, &p.textPolicyProofs, true,
		func(delivery access.EpochPackageDelivery) error { return writeProtectedDelivery(w, &sent, delivery) })
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) epochProofsHTTP(w http.ResponseWriter, r *http.Request) {
	channel, purpose := r.PathValue("channel"), r.PathValue("purpose")
	after, afterErr := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	through, throughErr := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
	if !validHexID(channel, 32) || afterErr != nil || throughErr != nil || through > uint64(migrationMaxSafePosition) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	scoped := p.scopedTextCache(r)
	proof, err := readProtectedProofRequest(r, scoped != nil, false)
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchEpochProofPage(r.Context(),
		p.resolveSession(memberBearer(r)), channel, purpose, after, through, verifyProtectedEpochSignature, scoped,
		func(proofs []access.EpochProof) error { return proof.write(w, &sent, proofs, "") })
	if err != nil && !sent {
		policyAttestationFail(w, proof.failure(err))
	}
}

func (p *protectedRuntime) archiveLinksHTTP(w http.ResponseWriter, r *http.Request) {
	channel, key := r.PathValue("channel"), r.PathValue("key")
	if !validHexID(channel, 32) || !validHexID(key, 64) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	scoped := p.scopedTextCache(r)
	proof, err := readProtectedProofRequest(r, scoped != nil, false)
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchArchiveLinks(r.Context(),
		p.resolveSession(memberBearer(r)), channel, key, verifyProtectedEpochSignature, scoped,
		func(delivery access.ArchiveLinkDelivery) error { return proof.write(w, &sent, delivery, "") })
	if err != nil && !sent {
		policyAttestationFail(w, proof.failure(err))
	}
}

func (p *protectedRuntime) liveHistoryHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	after, limit, err := protectedHistoryWindow(r)
	if err != nil || !validHexID(channel, 32) {
		memberFail(w, memberError(http.StatusBadRequest, "INVALID_PROTECTED_HISTORY_PAGE"))
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchLiveMessages(r.Context(), p.resolveSession(memberBearer(r)),
		channel, after, limit, p.scopedTextCache(r), p.importedProfileNames != nil,
		func(page access.LiveMessagePage) error { return writeProtectedDelivery(w, &sent, page) }, verifyProtectedEpochSignature)
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) scopedTextCache(r *http.Request) *access.TextChannelPolicyProofCache {
	if r.URL.Query().Get("scoped") == "1" {
		return &p.textPolicyProofs
	}
	return nil
}

func (p *protectedRuntime) appendLiveMessageHTTP(w http.ResponseWriter, r *http.Request) {
	var attempt access.MessageAttempt
	if _, err := decodeMemberJSON(w, r, 32000, &attempt); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(attempt.ChannelID, 32) || attempt.ChannelID != r.PathValue("channel") {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	if values := r.Header.Values("X-PawTalk-Deferred-Policy"); len(values) != 0 {
		rawRevision, digest, ok := strings.Cut(values[0], ":")
		revision, err := strconv.ParseInt(rawRevision, 10, 64)
		if len(values) != 1 || !ok || err != nil || revision < 1 || revision >= migrationMaxSafePosition || !validHexID(digest, 64) {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
		attempt.Deferred = &access.DeferredAdmission{Revision: revision, Head: digest}
	}
	receipt, err := p.protectedContentStore().AppendMessage(r.Context(),
		p.resolveSession(memberBearer(r)), verifyProtectedMessageAttempt, attempt, p.importedProfileNames != nil)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	if !receipt.Existing {
		p.events.publish(memberEvent{Type: "chat", ChannelID: attempt.ChannelID, Last: int64(receipt.Position),
			Revision: int64(receipt.Position), Delivery: true, protectedAppend: true})
	}
	respond(w, http.StatusOK, receipt)
}

func (p *protectedRuntime) mentionInboxHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		After string `json:"after"`
	}
	if _, err := decodeMemberJSON(w, r, 128, &input); err != nil {
		memberFail(w, err)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchMentionInbox(r.Context(), p.resolveSession(memberBearer(r)),
		input.After, func(page access.MentionInbox) error { return writeProtectedDelivery(w, &sent, page) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) mentionEligibilityHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchMentionEligibility(r.Context(), p.resolveSession(memberBearer(r)),
		channel, position, func(result access.MentionEligibility) error { return writeProtectedDelivery(w, &sent, result) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) importedHistoryLinkHTTP(w http.ResponseWriter, r *http.Request) {
	if p.importedProfileNames == nil {
		memberFail(w, memberError(http.StatusNotFound, "MIGRATION_HISTORY_LINK_NOT_FOUND"))
		return
	}
	var sent bool
	err := p.store.dispatchMigrationHistoryLink(r.Context(), p.resolveSession(memberBearer(r)), r.PathValue("channel"),
		func(link migrationHistoryLinkDelivery) error { return writeProtectedDelivery(w, &sent, link) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func writeProtectedDelivery(w http.ResponseWriter, sent *bool, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	switch value.(type) {
	case access.RotationTask, access.EpochPackageDelivery, []access.EpochPackageDelivery, []access.EpochProof, access.ArchiveLinkDelivery:
		if len(body) > protectedProofChunkBytes {
			return memberError(http.StatusRequestEntityTooLarge, "PROTECTED_PROOF_RESPONSE_TOO_LARGE")
		}
	}
	return writeProtectedDeliveryBody(w, sent, body, http.StatusOK, "application/json", nil)
}

func writeProtectedDeliveryBody(w http.ResponseWriter, sent *bool, body []byte, status int, contentType string, headers func(http.Header)) error {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	defer controller.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", contentType)
	if headers != nil {
		headers(w.Header())
	}
	*sent = true
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		return err
	}
	return controller.Flush()
}

func protectedRuntimeFail(w http.ResponseWriter, err error) {
	var wait access.SlowmodeWait
	var ban access.MemberBanError
	switch {
	case errors.As(err, &ban):
		err = protectedRemovalError(ban.MemberRemoval, true)
	case errors.Is(err, access.InvalidAction):
		err = memberError(http.StatusBadRequest, "INVALID_PROTECTED_ACTION")
	case errors.Is(err, access.TimedOut):
		err = memberError(http.StatusForbidden, "PROTECTED_TIMED_OUT")
	case errors.Is(err, access.Inactive), errors.Is(err, access.ChannelRestricted), errors.Is(err, access.MissingGrant):
		err = memberError(http.StatusForbidden, "PROTECTED_ACCESS_DENIED")
	case errors.Is(err, access.ErrPolicySignatureRequired), errors.Is(err, access.ErrPolicyConflict), errors.Is(err, access.ErrEpochConflict):
		err = memberError(http.StatusServiceUnavailable, "PROTECTED_STATE_UNAVAILABLE")
	case errors.Is(err, access.ErrEpochStale), errors.Is(err, access.ErrEpochRecipients):
		err = memberError(http.StatusConflict, "PROTECTED_KEY_PENDING")
	case errors.Is(err, access.ErrRotationUnavailable), errors.Is(err, access.ErrRotationLease):
		err = memberError(http.StatusConflict, "PROTECTED_ROTATION_UNAVAILABLE")
	case errors.Is(err, access.ErrPolicyAttestationUnavailable):
		err = memberError(http.StatusNotFound, "POLICY_ATTESTATION_UNAVAILABLE")
	case errors.Is(err, access.ErrVoiceGrantChanged):
		err = memberError(http.StatusConflict, "VOICE_GRANT_CHANGED")
	case errors.Is(err, access.ErrMessageConflict), errors.Is(err, access.ErrNonceReuse):
		err = memberError(http.StatusConflict, "PROTECTED_MESSAGE_CONFLICT")
	case errors.Is(err, access.ErrDeferredAdmissionChanged):
		err = memberError(http.StatusConflict, "PROTECTED_DEFERRED_ADMISSION_CHANGED")
	case errors.As(err, &wait):
		err = &membershipError{Status: http.StatusTooManyRequests, Code: "PROTECTED_SLOWMODE", Details: map[string]any{"retryAt": wait.RetryAt}}
	case errors.Is(err, access.ErrMessageRateLimit):
		err = memberError(http.StatusTooManyRequests, "PROTECTED_MESSAGE_RATE_LIMIT")
	case errors.Is(err, access.ErrStorageLimit):
		err = memberError(http.StatusInsufficientStorage, "STORAGE_LIMIT")
	case errors.Is(err, access.ErrAttachmentConflict):
		err = memberError(http.StatusConflict, "ATTACHMENT_CONFLICT")
	case errors.Is(err, access.ErrAttachmentLimit):
		err = memberError(http.StatusTooManyRequests, "ATTACHMENT_LIMIT")
	case errors.Is(err, access.ErrInviteConflict):
		err = memberError(http.StatusConflict, "PROTECTED_INVITE_CONFLICT")
	case errors.Is(err, access.ErrInviteCursor):
		err = memberError(http.StatusBadRequest, "PROTECTED_INVITE_CURSOR")
	case errors.Is(err, access.ErrInviteUnavailable):
		err = memberError(http.StatusGone, "PROTECTED_INVITE_UNAVAILABLE")
	}
	memberFail(w, err)
}
