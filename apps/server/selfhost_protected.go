package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"pawtalk/server/internal/access"
)

type protectedSelfhostOwner struct {
	ProfileKey   string `json:"profileKey"`
	DeviceKey    string `json:"deviceKey"`
	AgreementKey string `json:"agreementKey"`
	Nickname     string `json:"nickname"`
	DeviceLabel  string `json:"deviceLabel"`
}

type protectedSelfhostReady struct {
	ServerID       string `json:"serverId"`
	Binding        string `json:"binding"`
	CutoverDigest  string `json:"cutoverDigest"`
	OwnerProfileID string `json:"ownerProfileId"`
	OwnerDeviceID  string `json:"ownerDeviceId"`
	AnchorDigest   string `json:"anchorDigest,omitempty"`
}

type protectedSelfhostOffer struct {
	protectedSelfhostReady
	Draft    access.PolicyDraft `json:"draft"`
	Snapshot []byte             `json:"snapshot"`
}

type protectedSelfhostApproval struct {
	PolicySignature  string `json:"policySignature"`
	ProfileSignature string `json:"profileSignature"`
	ScopeAttestation string `json:"scopeAttestation,omitempty"`
}

type protectedSelfhostBootstrap struct {
	fingerprint string
	owner       protectedSelfhostOwner
	state       access.State
	offer       protectedSelfhostOffer
}

var errInvalidProtectedSelfhostOwner = errors.New("invalid protected selfhost owner")
var errInvalidProtectedSelfhostApproval = errors.New("invalid protected selfhost approval")

func prepareProtectedSelfhost(ctx context.Context, store *membershipStore, fingerprint string, owner protectedSelfhostOwner) (protectedSelfhostBootstrap, error) {
	var bootstrap protectedSelfhostBootstrap
	if !validHexID(fingerprint, 64) || !validHexID(owner.ProfileKey, 64) || !validHexID(owner.DeviceKey, 64) ||
		!validHexID(owner.AgreementKey, 64) || owner.ProfileKey == owner.DeviceKey || owner.ProfileKey == owner.AgreementKey ||
		owner.DeviceKey == owner.AgreementKey {
		return bootstrap, errInvalidProtectedSelfhostOwner
	}
	owner.Nickname, owner.DeviceLabel = strings.TrimSpace(owner.Nickname), strings.TrimSpace(owner.DeviceLabel)
	if !validNickname(owner.Nickname) || !validMemberLabel(owner.DeviceLabel) {
		return bootstrap, errInvalidProtectedSelfhostOwner
	}
	profileKey, _ := hex.DecodeString(owner.ProfileKey)
	deviceKey, _ := hex.DecodeString(owner.DeviceKey)
	actor := access.Principal{ProfileID: publicKeyID(profileKey), DeviceID: publicKeyID(deviceKey)}
	var serverID, text, voice string
	if err := store.db.QueryRowContext(ctx, `SELECT s.server_id,t.channel_id,v.channel_id
		FROM server_state s CROSS JOIN channels t CROSS JOIN channels v
		WHERE s.id=1 AND t.protected_kind='default_text' AND v.protected_kind='default_voice'`).Scan(&serverID, &text, &voice); err != nil {
		return bootstrap, err
	}
	state := access.State{
		RoleSnapshot: access.RoleSnapshot{
			Policy: access.Policy{Owner: actor.ProfileID, Roles: map[string]access.Role{
				access.Everyone: {Grants: []string{
					access.ChannelView, "history.full", "profile.edit-self",
					"message.send", "message.attach", "message.voice", "poll.create", "poll.vote",
					"checklist.create", "checklist.check", "voice.connect", "voice.speak",
				}},
			}},
			Members: map[string]access.Subject{actor.ProfileID: {ID: actor.ProfileID, Active: true}},
		},
		Channels: map[string]access.Channel{
			text:  {Kind: "text", NextPosition: 1, Settings: &access.ChannelSettings{Name: "Общий"}},
			voice: {Kind: "voice", NextPosition: 1, Settings: &access.ChannelSettings{Name: "Основной", VoiceCapacity: 30}},
		},
		ChannelOrder: []string{text, voice},
		PolicyDevices: map[string]access.PolicyDevice{
			actor.DeviceID: {ProfileID: actor.ProfileID, PublicKey: owner.DeviceKey},
		},
		KeyRecipients: map[string]access.KeyRecipient{
			actor.DeviceID: {ProfileID: actor.ProfileID, Kind: "device", PublicKey: owner.AgreementKey},
		},
	}
	binding, err := randomHex(32)
	if err != nil {
		return bootstrap, err
	}
	operation, err := randomHex(16)
	if err != nil {
		return bootstrap, err
	}
	seed, err := randomHex(32)
	if err != nil {
		return bootstrap, err
	}
	draft, snapshot, err := access.PreviewInitialPolicy(state, actor, operation, seed, access.ProfileRoleAuthorityProjectionVersion)
	if err != nil {
		return bootstrap, err
	}
	frame, err := signatureFrame("pawtalk-selfhost-cutover-v1", serverID, fingerprint, binding, actor.ProfileID, actor.DeviceID,
		owner.AgreementKey, draft.ResultDigest)
	if err != nil {
		return bootstrap, err
	}
	return protectedSelfhostBootstrap{fingerprint: fingerprint, owner: owner, state: state, offer: protectedSelfhostOffer{
		protectedSelfhostReady: protectedSelfhostReady{ServerID: serverID, Binding: binding, CutoverDigest: publicKeyID(frame),
			OwnerProfileID: actor.ProfileID, OwnerDeviceID: actor.DeviceID},
		Draft: draft, Snapshot: snapshot,
	}}, nil
}

func (b protectedSelfhostBootstrap) ownerFrame() ([]byte, error) {
	return signatureFrame("pawtalk-selfhost-owner-v1", b.offer.ServerID, b.fingerprint, b.offer.Binding, b.offer.CutoverDigest,
		b.offer.OwnerProfileID, b.offer.OwnerDeviceID, b.owner.AgreementKey, b.offer.Draft.ResultDigest)
}

func (b protectedSelfhostBootstrap) activate(ctx context.Context, store *membershipStore, approval protectedSelfhostApproval) (*protectedRuntime, protectedSelfhostReady, error) {
	return b.activateWithReceipt(ctx, store, approval, nil)
}

func (b protectedSelfhostBootstrap) activateWithReceipt(ctx context.Context, store *membershipStore, approval protectedSelfhostApproval,
	saveReceipt func(*sql.Tx, protectedSelfhostReady) error) (*protectedRuntime, protectedSelfhostReady, error) {
	var ready protectedSelfhostReady
	rootSignature, rootErr := decodeFixed(approval.ProfileSignature, ed25519.SignatureSize)
	policySignature, policyErr := decodeFixed(approval.PolicySignature, ed25519.SignatureSize)
	profileKey, _ := hex.DecodeString(b.owner.ProfileKey)
	deviceKey, _ := hex.DecodeString(b.owner.DeviceKey)
	frame, err := b.ownerFrame()
	if err != nil {
		return nil, ready, err
	}
	if rootErr != nil || policyErr != nil || !ed25519.Verify(profileKey, frame, rootSignature) {
		return nil, ready, errInvalidProtectedSelfhostApproval
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, ready, err
	}
	defer tx.Rollback()
	actor := access.Principal{ProfileID: b.offer.OwnerProfileID, DeviceID: b.offer.OwnerDeviceID}
	now := store.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, "INSERT INTO profiles(profile_id,identity_public_key,nickname,created_at) VALUES(?,?,?,?)",
		actor.ProfileID, profileKey, b.owner.Nickname, now); err != nil {
		return nil, ready, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO devices(device_id,original_profile_id,signing_public_key,label,identity_certificate,created_at)
		VALUES(?,?,?,?,?,?)`, actor.DeviceID, actor.ProfileID, deviceKey, b.owner.DeviceLabel, rootSignature, now); err != nil {
		return nil, ready, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO memberships(profile_id,state,joined_at) VALUES(?,'active',?)", actor.ProfileID, now); err != nil {
		return nil, ready, err
	}
	draft := b.offer.Draft
	draft.Signature = policySignature
	proof, err := access.NewStoreWithClock(store.db, store.now).InstallSignedInitialPolicy(ctx, tx, b.state, actor, verifyProtectedPolicyDraft, draft)
	if err != nil {
		return nil, ready, err
	}
	if approval.ScopeAttestation != "" {
		signature, err := decodeFixed(approval.ScopeAttestation, ed25519.SignatureSize)
		if err != nil {
			return nil, ready, errInvalidProtectedSelfhostApproval
		}
		if err := access.StoreInitialPolicyScopeAttestation(ctx, tx, actor, signature, verifyProtectedPolicyAttestation); err != nil {
			return nil, ready, err
		}
	}
	if _, err := tx.ExecContext(ctx, protectedSessionSchema+protectedVoiceKeySchema); err != nil {
		return nil, ready, err
	}
	ready = b.offer.protectedSelfhostReady
	ready.AnchorDigest = proof.Digest
	if saveReceipt != nil {
		if err := saveReceipt(tx, ready); err != nil {
			return nil, protectedSelfhostReady{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, ready, err
	}
	runtimeStore := &membershipStore{db: store.db, now: store.now, maxBytes: store.maxBytes, protectedBinding: ready.Binding}
	return &protectedRuntime{store: runtimeStore, serverID: ready.ServerID, cutoverDigest: ready.CutoverDigest,
		anchorDigest: ready.AnchorDigest, challenges: make(map[string]int64)}, ready, nil
}

func bootstrapProtectedSelfhost(ctx context.Context, store *membershipStore, fingerprint string, owner protectedSelfhostOwner,
	control *json.Decoder, output *json.Encoder) (*protectedRuntime, protectedSelfhostReady, error) {
	bootstrap, err := prepareProtectedSelfhost(ctx, store, fingerprint, owner)
	if err != nil {
		return nil, protectedSelfhostReady{}, err
	}
	if err := output.Encode(map[string]any{"fingerprint": fingerprint, "protected": bootstrap.offer}); err != nil {
		return nil, protectedSelfhostReady{}, err
	}
	var approval protectedSelfhostApproval
	if err := control.Decode(&approval); err != nil {
		return nil, protectedSelfhostReady{}, err
	}
	return bootstrap.activate(ctx, store, approval)
}
