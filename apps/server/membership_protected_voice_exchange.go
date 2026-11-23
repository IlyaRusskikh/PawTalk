package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"pawtalk/server/internal/access"
)

const protectedVoiceKeySchema = `
CREATE TABLE IF NOT EXISTS protected_voice_keys (
	channel_id TEXT PRIMARY KEY,
	epoch_id TEXT NOT NULL,
	binding TEXT NOT NULL,
	revision INTEGER NOT NULL,
	policy_digest TEXT NOT NULL,
	roster_digest TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	author_session TEXT NOT NULL DEFAULT '',
	commitment TEXT NOT NULL DEFAULT '',
	signature BLOB NOT NULL DEFAULT X'',
	offer_digest TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS protected_voice_keys_expiry ON protected_voice_keys(expires_at);
CREATE TABLE IF NOT EXISTS protected_voice_key_packages (
	channel_id TEXT NOT NULL REFERENCES protected_voice_keys(channel_id) ON DELETE CASCADE,
	session_id TEXT NOT NULL,
	ciphertext BLOB NOT NULL CHECK(length(ciphertext)=80),
	PRIMARY KEY(channel_id,session_id)
) STRICT;`

type protectedVoiceKeyClaim struct {
	Basis      protectedVoiceKeyBasis               `json:"basis"`
	Roster     []access.VoiceKeyRecipient           `json:"roster"`
	Policy     *access.VoiceChannelPolicyDisclosure `json:"policy,omitempty"`
	Published  bool                                 `json:"published"`
	ServerTime int64                                `json:"serverTime"`
}

type protectedVoiceKeyDelivery struct {
	Basis         protectedVoiceKeyBasis               `json:"basis"`
	Roster        []access.VoiceKeyRecipient           `json:"roster"`
	Policy        *access.VoiceChannelPolicyDisclosure `json:"policy,omitempty"`
	AuthorSession string                               `json:"authorSession"`
	Commitment    string                               `json:"commitment"`
	Signature     []byte                               `json:"signature"`
	Ciphertext    []byte                               `json:"ciphertext"`
	ServerTime    int64                                `json:"serverTime"`
}

type protectedVoiceKeyState struct {
	protectedVoiceKeyClaim
	actor       access.VoiceKeyRecipient
	now         time.Time
	basis       protectedVoiceKeyBasis
	storedBasis protectedVoiceKeyBasis
	head        access.PolicyProof
	author      string
	commitment  string
	signature   []byte
	offerDigest string
}

func (p *protectedRuntime) prepareVoiceSlot(ctx context.Context, token, channel string) (bool, error) {
	if !validHexID(channel, 32) {
		return false, access.ChannelRestricted
	}
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	member, actor, err := p.store.runtimeIdentityForToken(ctx, tx, token)
	if err != nil {
		return false, err
	}
	now := p.store.now()
	var wasPresent bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_voice_slots WHERE channel_id=? AND
		session_id=? AND active_until>? AND disconnect_pending=0)`, channel, member.SessionID, now.UnixMilli()).Scan(&wasPresent); err != nil {
		return false, err
	}
	admission, err := access.ReserveRuntimeVoice(ctx, tx, actor, member.SessionID, channel, now.UnixMilli(),
		now.Add(protectedVoiceLease).UnixMilli(), 0)
	if err != nil {
		return false, err
	}
	if !wasPresent && admission.CanReceiveKey {
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_keys WHERE channel_id=?", channel); err != nil {
			return false, err
		}
	}
	return !admission.CanReceiveKey, tx.Commit()
}

func (p *protectedRuntime) readVoiceKeyState(ctx context.Context, tx *sql.Tx, token, channel string) (protectedVoiceKeyState, error) {
	if !validHexID(channel, 32) {
		return protectedVoiceKeyState{}, access.ChannelRestricted
	}
	member, actor, err := p.store.runtimeIdentityForToken(ctx, tx, token)
	if err != nil {
		return protectedVoiceKeyState{}, err
	}
	return p.store.voiceKeyState(ctx, tx, p.serverID, channel, member.SessionID, actor, p.store.now())
}

func (s *membershipStore) voiceKeyState(ctx context.Context, tx *sql.Tx, serverID, channel, session string,
	actor access.Principal, now time.Time) (protectedVoiceKeyState, error) {
	state := protectedVoiceKeyState{now: now}
	state.ServerTime = now.UnixMilli()
	var err error
	state.Roster, err = access.ReadVoiceKeyRoster(ctx, tx, channel, s.protectedBinding, now.UnixMilli())
	if err != nil {
		return state, err
	}
	index := slices.IndexFunc(state.Roster, func(entry access.VoiceKeyRecipient) bool {
		return entry.SessionID == session && entry.DeviceID == actor.DeviceID && entry.ProfileID == actor.ProfileID
	})
	if index < 0 {
		return state, access.ChannelRestricted
	}
	state.actor = state.Roster[index]
	head, err := access.ReadPolicyHead(ctx, tx, &actor)
	if err != nil {
		return state, err
	}
	state.head = head
	digest, err := protectedVoiceRosterDigest(state.Roster)
	if err != nil {
		return state, err
	}
	state.basis = protectedVoiceKeyBasis{ServerID: serverID, ChannelID: channel, Binding: s.protectedBinding,
		Revision: head.Draft.Revision, PolicyDigest: head.Draft.ResultDigest, RosterDigest: digest}
	stored := protectedVoiceKeyBasis{ServerID: serverID, ChannelID: channel}
	err = tx.QueryRowContext(ctx, `SELECT epoch_id,binding,revision,policy_digest,roster_digest,expires_at,
		author_session,commitment,signature,offer_digest FROM protected_voice_keys WHERE channel_id=?`, channel).
		Scan(&stored.EpochID, &stored.Binding, &stored.Revision, &stored.PolicyDigest, &stored.RosterDigest, &stored.ExpiresAt,
			&state.author, &state.commitment, &state.signature, &state.offerDigest)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = nil
		}
		return state, err
	}
	expected := state.basis
	expected.EpochID, expected.ExpiresAt = stored.EpochID, stored.ExpiresAt
	state.storedBasis = stored
	if expected == stored && stored.ExpiresAt > state.now.UnixMilli() {
		state.Basis = stored
		state.Published = state.offerDigest != ""
	}
	return state, nil
}

func (s *membershipStore) validateVoiceKeyGrant(ctx context.Context, tx *sql.Tx, server, channel, session, epoch string,
	actor access.Principal, now time.Time) (time.Time, error) {
	if !validHexID(epoch, 32) {
		return time.Time{}, access.ErrVoiceGrantChanged
	}
	state, err := s.voiceKeyState(ctx, tx, server, channel, session, actor, now)
	if err != nil {
		return time.Time{}, err
	}
	if !state.Published || state.Basis.EpochID != epoch {
		return time.Time{}, access.ErrVoiceGrantChanged
	}
	var exists bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM protected_voice_key_packages WHERE channel_id=? AND session_id=?)`,
		channel, session).Scan(&exists)
	if err != nil {
		return time.Time{}, err
	}
	if !exists {
		return time.Time{}, access.ErrVoiceGrantChanged
	}
	return time.UnixMilli(state.Basis.ExpiresAt), nil
}

type protectedVoiceKeyHeartbeat struct {
	Refresh  bool `json:"refresh"`
	Deafened bool `json:"deafened,omitempty"`
}

func (p *protectedRuntime) heartbeatVoiceKey(ctx context.Context, token, channel, epoch string) (protectedVoiceKeyHeartbeat, error) {
	var result protectedVoiceKeyHeartbeat
	if (epoch != "" && !validHexID(epoch, 32)) || !validHexID(channel, 32) {
		return result, access.InvalidAction
	}
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	member, actor, err := p.store.runtimeIdentityForToken(ctx, tx, token)
	if err != nil {
		return result, err
	}
	now := p.store.now()
	result.Deafened, err = access.RefreshRuntimeVoiceLease(ctx, tx, actor, member.SessionID, channel, now.UnixMilli(), now.Add(protectedVoiceLease).UnixMilli())
	leaseErr := err
	if leaseErr != nil && !errors.Is(leaseErr, access.ErrVoiceGrantChanged) {
		return result, err
	}
	if result.Deafened {
		return result, tx.Commit()
	}
	state, err := p.store.voiceKeyState(ctx, tx, p.serverID, channel, member.SessionID, actor, now)
	if err != nil {
		return result, err
	}
	keep, err := state.keepsInstalledKeyAfterVoiceModeration(ctx, tx, epoch)
	if err != nil {
		return result, err
	}
	if keep {
		// The existing key remains verified. A pending media permission update
		// still cannot extend the lease until LiveKit acknowledges it.
		return result, tx.Commit()
	}
	if leaseErr != nil {
		return result, leaseErr
	}
	result.Refresh = !state.Published || state.Basis.EpochID != epoch || state.Basis.ExpiresAt <= state.renewalDeadline()
	return result, tx.Commit()
}

func (state protectedVoiceKeyState) keepsInstalledKeyAfterVoiceModeration(ctx context.Context, tx *sql.Tx, epoch string) (bool, error) {
	stored := state.storedBasis
	revisions := state.basis.Revision - stored.Revision
	if epoch == "" || stored.EpochID != epoch || state.offerDigest == "" || stored.Binding != state.basis.Binding ||
		stored.RosterDigest != state.basis.RosterDigest || stored.ExpiresAt <= state.renewalDeadline() ||
		revisions <= 0 || revisions > 64 {
		return false, nil
	}
	var moderationRevisions int64
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM protected_policy_proofs WHERE revision>? AND revision<=?
		AND (json_extract(CAST(record AS TEXT),'$.Draft.Action')=? OR
			(json_extract(CAST(record AS TEXT),'$.Draft.Action')=? AND
			 json_extract(CAST(record AS TEXT),'$.Draft.ResourceChange.Mode')='server-media'))`,
		stored.Revision, state.basis.Revision, access.ChangeVoiceMute, access.ChangeVoiceDeafen).Scan(&moderationRevisions)
	return moderationRevisions == revisions, err
}

func (state protectedVoiceKeyState) renewalDeadline() int64 {
	return state.now.Add(protectedVoiceKeyTTL - protectedVoiceLease).UnixMilli()
}

func (p *protectedRuntime) claimVoiceKey(ctx context.Context, token, channel string) (protectedVoiceKeyClaim, error) {
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	defer tx.Rollback()
	state, err := p.readVoiceKeyState(ctx, tx, token, channel)
	if err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	state.Policy, err = access.ReadVoiceChannelPolicy(ctx, tx, state.head, channel, state.Roster, &p.textPolicyProofs)
	if err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	if state.Basis.EpochID != "" && state.Basis.ExpiresAt > state.renewalDeadline() {
		return state.protectedVoiceKeyClaim, nil
	}
	epoch, err := randomHex(16)
	if err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	basis := state.basis
	basis.EpochID, basis.ExpiresAt = epoch, state.now.Add(protectedVoiceKeyTTL).UnixMilli()
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_keys WHERE channel_id=? OR expires_at<=?",
		channel, state.now.UnixMilli()); err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_voice_keys
		(channel_id,epoch_id,binding,revision,policy_digest,roster_digest,expires_at) VALUES(?,?,?,?,?,?,?)`,
		channel, epoch, basis.Binding, basis.Revision, basis.PolicyDigest, basis.RosterDigest, basis.ExpiresAt); err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	if err := tx.Commit(); err != nil {
		return protectedVoiceKeyClaim{}, err
	}
	state.Basis = basis
	state.Published = false
	return state.protectedVoiceKeyClaim, nil
}

func (p *protectedRuntime) publishVoiceKey(ctx context.Context, token, channel string, offer protectedVoiceKeyOffer) error {
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	state, err := p.readVoiceKeyState(ctx, tx, token, channel)
	if err != nil {
		return err
	}
	if state.Basis.EpochID == "" || offer.Basis != state.Basis {
		return access.ErrVoiceGrantChanged
	}
	if err := verifyProtectedVoiceKeyOffer(ctx, tx, state.now, state.Basis, state.Roster, state.actor, offer); err != nil {
		return err
	}
	raw, err := json.Marshal(offer)
	if err != nil {
		return err
	}
	digest := publicKeyID(raw)
	if state.Published {
		if state.author == state.actor.SessionID && state.offerDigest == digest {
			return nil
		}
		return access.ErrVoiceGrantChanged
	}
	result, err := tx.ExecContext(ctx, `UPDATE protected_voice_keys SET author_session=?,commitment=?,signature=?,offer_digest=?
		WHERE channel_id=? AND epoch_id=? AND offer_digest=''`, state.actor.SessionID, offer.Commitment,
		offer.Signature, digest, channel, state.Basis.EpochID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return errors.Join(access.ErrVoiceGrantChanged, err)
	}
	for session, packet := range offer.Packages {
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_voice_key_packages (channel_id,session_id,ciphertext)
			VALUES(?,?,?)`, channel, session, packet); err != nil {
			return err
		}
	}
	if p.store.now().UnixMilli() >= state.Basis.ExpiresAt {
		return access.ErrVoiceGrantChanged
	}
	return tx.Commit()
}

func (p *protectedRuntime) dispatchVoiceKey(ctx context.Context, token, channel string, send func(protectedVoiceKeyDelivery) error) error {
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	state, err := p.readVoiceKeyState(ctx, tx, token, channel)
	if err != nil {
		return err
	}
	if !state.Published {
		return access.ErrEpochStale
	}
	policy, err := access.ReadVoiceChannelPolicy(ctx, tx, state.head, channel, state.Roster, &p.textPolicyProofs)
	if err != nil {
		return err
	}
	delivery := protectedVoiceKeyDelivery{Basis: state.Basis, Roster: state.Roster, Policy: policy, AuthorSession: state.author,
		Commitment: state.commitment, Signature: state.signature, ServerTime: state.ServerTime}
	if err := tx.QueryRowContext(ctx, `SELECT ciphertext FROM protected_voice_key_packages WHERE channel_id=? AND session_id=?`,
		channel, state.actor.SessionID).Scan(&delivery.Ciphertext); err != nil {
		return err
	}
	return send(delivery)
}
