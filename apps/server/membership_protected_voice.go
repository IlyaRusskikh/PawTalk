package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"pawtalk/server/internal/access"
)

const protectedVoiceLease = 45 * time.Second

func protectedVoiceRoom(serverID, channel string) string {
	return "ptp-" + serverID + "-" + channel
}

func (s *membershipStore) joinProtectedVoice(ctx context.Context, token, channel string, cfg config) (memberVoice, error) {
	return s.joinProtectedVoiceWithKey(ctx, token, channel, "", cfg)
}

func (s *membershipStore) joinProtectedVoiceWithKey(ctx context.Context, token, channel, epoch string, cfg config) (memberVoice, error) {
	var result memberVoice
	if !validHexID(channel, 32) {
		return result, access.ChannelRestricted
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	member, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return result, err
	}
	now := s.now()
	expires := now.Add(protectedVoiceLease)
	deafened := false
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return result, err
	}
	if s.protectedBinding != "" {
		deafened = epoch == ""
		if deafened {
			if err := access.AuthorizeDeafenedVoiceGrant(ctx, tx, actor, member.SessionID, channel, now.UnixMilli()); err != nil {
				return result, err
			}
		} else {
			keyDeadline, err := s.validateVoiceKeyGrant(ctx, tx, serverID, channel, member.SessionID, epoch, actor, now)
			if err != nil {
				return result, err
			}
			if expires.After(keyDeadline) {
				expires = keyDeadline
			}
		}
		expires = expires.Truncate(time.Second)
		if !expires.After(now) {
			return result, access.ErrVoiceGrantChanged
		}
	} else if epoch != "" {
		return result, access.InvalidAction
	}
	admission, err := access.ReserveVoice(ctx, tx, actor, member.SessionID, channel, now.UnixMilli(),
		now.Add(protectedVoiceLease).UnixMilli(), expires.Unix()*1000)
	if err != nil {
		return result, err
	}
	name, err := protectedMemberNickname(ctx, tx, actor.ProfileID)
	if err != nil {
		return result, err
	}
	room := protectedVoiceRoom(serverID, channel)
	video := map[string]any{"roomJoin": true, "room": room,
		"canPublish": admission.CanSpeak, "canSubscribe": admission.CanReceive, "canPublishData": false, "canUpdateOwnMetadata": false}
	if admission.CanSpeak {
		video["canPublishSources"] = []string{"microphone", "screen_share", "screen_share_audio"}
	}
	grantID, err := randomHex(16)
	if err != nil {
		return result, err
	}
	attributes := map[string]string{"pawtalk.e2ee": "required", "pawtalk.profile": actor.ProfileID, "pawtalk.device": actor.DeviceID}
	if epoch != "" {
		attributes["pawtalk.voice-epoch"] = epoch
	}
	if deafened {
		attributes["pawtalk.voice-parked"] = "true"
	}
	claims := map[string]any{"iss": cfg.APIKey, "sub": member.SessionID, "jti": grantID, "name": name, "nbf": now.Unix() - 5, "exp": expires.Unix(),
		"video": video, "attributes": attributes}
	// The policy reserves slots transactionally. A LiveKit room creation limit
	// would stay at its original value while the room is occupied.
	signed, err := signedMediaClaims(cfg, claims)
	if err != nil {
		return result, err
	}
	if err := access.RecordVoiceGrant(ctx, tx, channel, actor.ProfileID, member.SessionID, publicKeyID([]byte(signed)), admission.Capacity); err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return memberVoice{URL: cfg.LivekitURL, Token: signed, ChannelID: channel, Identity: member.SessionID, Room: room,
		ExpiresAt: expires.UnixMilli(), E2EERequired: true, KeyEpoch: epoch, ServerDeafened: deafened}, nil
}

func (s *membershipStore) reconcileProtectedVoice(ctx context.Context, cfg config, channel, profile string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	head, err := access.ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return err
	}
	if head.Digest == "" {
		return access.ErrPolicySignatureRequired
	}
	if err := verifyProtectedPolicyDraft(ctx, tx, head.Principal, head.Draft); err != nil {
		return err
	}
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	room := protectedVoiceRoom(serverID, channel)
	now := s.now()
	if err := access.ReconcileVoice(ctx, tx, channel, profile, now.UnixMilli(), func(session string, admission *access.VoiceAdmission) error {
		body := map[string]any{"room": room, "identity": session}
		if admission == nil {
			err := callRoomService(ctx, cfg, now, room, "RemoveParticipant", body)
			var status mediaResponseError
			if errors.As(err, &status) && status.Status == http.StatusNotFound {
				return nil
			}
			return err
		}
		permission := map[string]any{"canPublish": admission.CanSpeak, "canSubscribe": admission.CanReceive,
			"canPublishData": false, "canUpdateMetadata": false}
		if admission.CanSpeak {
			permission["canPublishSources"] = []string{"MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"}
		}
		body["permission"] = permission
		return callRoomService(ctx, cfg, now, room, "UpdateParticipant", body)
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *membershipStore) reconcilePendingProtectedVoice(ctx context.Context, cfg config) error {
	store := access.NewStoreWithClock(s.db, s.now)
	moves, err := store.PendingVoiceMoveProfiles(ctx)
	if err != nil {
		return err
	}
	var failed error
	for _, profile := range moves {
		failed = errors.Join(failed, s.applyProtectedVoiceMove(ctx, cfg, profile))
	}
	targets, err := store.PendingVoiceControls(ctx)
	if err != nil {
		return errors.Join(failed, err)
	}
	for _, target := range targets {
		failed = errors.Join(failed, s.reconcileProtectedVoice(ctx, cfg, target.ChannelID, target.ProfileID))
	}
	return failed
}

func (s *membershipStore) planProtectedVoiceMove(ctx context.Context, cfg config, token, profile, source, destination string) error {
	return s.planProtectedVoiceMoveTarget(ctx, cfg, token, profile, "", source, destination)
}

func (s *membershipStore) planProtectedVoiceMoveTarget(ctx context.Context, cfg config, token, profile, targetSession, source, destination string) error {
	if !validHexID(source, 32) || (destination != "" && !validHexID(destination, 32)) {
		return access.ChannelRestricted
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	member, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return err
	}
	if profile == actor.ProfileID && targetSession == "" {
		return access.HierarchyDenied
	}
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	now := s.now()
	room := protectedVoiceRoom(serverID, source)
	observe := func(session string) error {
		if targetSession != "" && targetSession != session {
			return access.ChannelRestricted
		}
		body := map[string]string{"room": room, "identity": session}
		var participant struct {
			Identity string
			State    json.RawMessage
		}
		if err := roomServiceJSON(ctx, cfg, now, room, "GetParticipant", body, &participant); err != nil {
			var status mediaResponseError
			if errors.As(err, &status) && status.Status == http.StatusNotFound {
				return access.ErrVoiceSlotLost
			}
			return err
		}
		if participant.Identity != session || (string(participant.State) != `"ACTIVE"` && string(participant.State) != "2") {
			return access.ErrVoiceSlotLost
		}
		return nil
	}
	if targetSession != "" {
		err = access.PlanVoiceMoveSession(ctx, tx, actor, member.SessionID, targetSession, source, destination, now.UnixMilli(), now.Add(protectedVoiceLease).UnixMilli(), observe)
	} else {
		err = access.PlanVoiceMove(ctx, tx, actor, profile, source, destination, now.UnixMilli(), now.Add(protectedVoiceLease).UnixMilli(), observe)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *membershipStore) protectedVoiceMoveChoices(ctx context.Context, token, source, targetSession string) ([]string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	_, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return nil, err
	}
	return access.VoiceMoveChoices(ctx, tx, actor, source, targetSession, s.now().UnixMilli())
}

func (s *membershipStore) protectedVoiceRestrictionChoices(ctx context.Context, token, source, targetSession string) (access.VoiceRestrictionChoices, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return access.VoiceRestrictionChoices{}, err
	}
	defer tx.Rollback()
	_, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return access.VoiceRestrictionChoices{}, err
	}
	return access.ReadVoiceRestrictionChoices(ctx, tx, actor, source, targetSession, s.now().UnixMilli())
}

func (s *membershipStore) disconnectProtectedVoice(ctx context.Context, cfg config, token, source, targetSession string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return err
	}
	target, err := access.DisconnectVoiceSession(ctx, tx, actor, source, targetSession, s.now().UnixMilli())
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return s.reconcileProtectedVoice(ctx, cfg, source, target)
}

func (s *membershipStore) applyProtectedVoiceMove(ctx context.Context, cfg config, profile string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	head, err := access.ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return err
	}
	if head.Digest == "" {
		return access.ErrPolicySignatureRequired
	}
	if err := verifyProtectedPolicyDraft(ctx, tx, head.Principal, head.Draft); err != nil {
		return err
	}
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	now := s.now()
	if err := access.ApplyVoiceMove(ctx, tx, profile, now.UnixMilli(), func(move access.VoiceMove) error {
		room := protectedVoiceRoom(serverID, move.Source)
		err := callRoomService(ctx, cfg, now, room, "RemoveParticipant", map[string]string{"room": room, "identity": move.SessionID})
		var status mediaResponseError
		if err == nil || errors.As(err, &status) && status.Status == http.StatusNotFound {
			s.voiceNetwork.forget(move.SessionID)
			return nil
		}
		return err
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *membershipStore) readyProtectedVoiceMove(ctx context.Context, token string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	member, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return "", err
	}
	return access.ReadyVoiceMove(ctx, tx, actor, member.SessionID, s.now().UnixMilli())
}

func (s *membershipStore) heartbeatProtectedVoice(ctx context.Context, token string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	member, actor, err := s.protectedIdentity(ctx, tx, token)
	if err != nil {
		return err
	}
	now := s.now()
	if err := access.RefreshVoice(ctx, tx, actor, member.SessionID, now.UnixMilli(), now.Add(protectedVoiceLease).UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *membershipStore) leaveProtectedVoice(ctx context.Context, token string) (string, string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	// Releasing a slot does not depend on current channel permissions.
	var member memberAccess
	if s.protectedBinding != "" {
		member, _, err = s.runtimeIdentityForToken(ctx, tx, token)
	} else {
		member, err = s.sessionIdentity(ctx, tx, token)
	}
	if err != nil {
		return "", "", err
	}
	actor := access.Principal{ProfileID: member.EffectiveProfileID, DeviceID: member.DeviceID}
	channel, err := access.ReleaseVoice(ctx, tx, actor, member.SessionID)
	if err != nil {
		return "", "", err
	}
	var room string
	if channel != "" {
		s.voiceNetwork.forget(member.SessionID)
		if s.protectedBinding != "" {
			if _, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_keys WHERE channel_id=?", channel); err != nil {
				return "", "", err
			}
		}
		var serverID string
		if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
			return "", "", err
		}
		room = protectedVoiceRoom(serverID, channel)
	}
	if err := tx.Commit(); err != nil {
		return "", "", err
	}
	return room, member.SessionID, nil
}
