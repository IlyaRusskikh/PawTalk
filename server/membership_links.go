package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
)

type memberLink struct {
	ID                string          `json:"id"`
	State             string          `json:"state"`
	TargetProfileID   string          `json:"targetProfileId"`
	SourceProfileID   string          `json:"sourceProfileId"`
	ChosenProfileID   string          `json:"chosenProfileId"`
	TargetDeviceID    string          `json:"targetDeviceId"`
	SourceDeviceID    string          `json:"sourceDeviceId"`
	TargetExchangeKey string          `json:"targetExchangeKey"`
	SourceExchangeKey string          `json:"sourceExchangeKey"`
	TargetRevision    int64           `json:"targetRevision"`
	SourceRevision    int64           `json:"sourceRevision"`
	ExpiresAt         int64           `json:"expiresAt"`
	SourceProof       string          `json:"sourceProof"`
	TargetProof       string          `json:"targetProof"`
	KeyEnvelope       json.RawMessage `json:"keyEnvelope"`
	SourceDeviceKey   string          `json:"sourceDeviceKey"`
	SourceProfileKey  string          `json:"sourceProfileKey"`
	SourceCertificate string          `json:"sourceCertificate"`
	SourceNickname    string          `json:"sourceNickname,omitempty"`
	TargetNickname    string          `json:"targetNickname,omitempty"`
}
type memberLinkStart struct {
	RequestID   string `json:"requestId"`
	TokenHash   string `json:"tokenHash"`
	ExchangeKey string `json:"exchangeKey"`
}
type memberLinkProposal struct {
	Token           string `json:"token"`
	Nickname        string `json:"nickname"`
	DeviceLabel     string `json:"deviceLabel"`
	ExchangeKey     string `json:"exchangeKey"`
	ChosenProfileID string `json:"chosenProfileId"`
	Signature       string `json:"signature"`
}
type memberLinkApproval struct {
	Signature   string          `json:"signature"`
	KeyEnvelope json.RawMessage `json:"keyEnvelope"`
}

func mainDeviceTx(ctx context.Context, tx *sql.Tx, root string) (string, int64, error) {
	var device string
	var revision int64
	err := tx.QueryRowContext(ctx, "SELECT primary_device_id,revision FROM profile_controls WHERE profile_id=?", root).Scan(&device, &revision)
	return device, revision, err
}
func groupProfilesTx(ctx context.Context, tx *sql.Tx, root string) ([]string, error) {
	result := []string{root}
	rows, err := tx.QueryContext(ctx, "SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=? ORDER BY source_profile_id", root)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, id)
	}
	return result, closeMemberRows(rows)
}
func (s *membershipStore) loadLinkTx(ctx context.Context, tx *sql.Tx, id string) (memberLink, error) {
	var v memberLink
	var targetExchange, sourceExchange, sourceProof, targetProof, envelope []byte
	err := tx.QueryRowContext(ctx, `SELECT request_id,state,target_profile_id,COALESCE(source_profile_id,''),COALESCE(chosen_profile_id,''),target_main_device_id,COALESCE(source_main_device_id,''),target_exchange_key,source_exchange_key,target_revision,COALESCE(source_revision,0),expires_at,source_proof,target_proof,key_envelope FROM device_link_requests WHERE request_id=?`, id).Scan(&v.ID, &v.State, &v.TargetProfileID, &v.SourceProfileID, &v.ChosenProfileID, &v.TargetDeviceID, &v.SourceDeviceID, &targetExchange, &sourceExchange, &v.TargetRevision, &v.SourceRevision, &v.ExpiresAt, &sourceProof, &targetProof, &envelope)
	if errors.Is(err, sql.ErrNoRows) {
		return v, memberError(404, "LINK_NOT_FOUND")
	}
	if err != nil {
		return v, err
	}
	v.TargetExchangeKey = b64.EncodeToString(targetExchange)
	v.SourceExchangeKey = b64.EncodeToString(sourceExchange)
	v.SourceProof = b64.EncodeToString(sourceProof)
	v.TargetProof = b64.EncodeToString(targetProof)
	v.KeyEnvelope = envelope
	if v.SourceDeviceID != "" {
		var deviceKey, profileKey, certificate []byte
		if err = tx.QueryRowContext(ctx, "SELECT d.signing_public_key,p.identity_public_key,d.identity_certificate FROM devices d JOIN profiles p ON p.profile_id=d.original_profile_id WHERE d.device_id=?", v.SourceDeviceID).Scan(&deviceKey, &profileKey, &certificate); err != nil {
			return v, err
		}
		v.SourceDeviceKey = b64.EncodeToString(deviceKey)
		v.SourceProfileKey = b64.EncodeToString(profileKey)
		v.SourceCertificate = b64.EncodeToString(certificate)
	}
	if v.State != "confirmed" && v.ExpiresAt <= s.now().UnixMilli() {
		return v, memberError(410, "LINK_EXPIRED")
	}
	return v, nil
}
func (s *membershipStore) linkFrameTx(ctx context.Context, tx *sql.Tx, v memberLink) ([]byte, error) {
	var server string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&server); err != nil {
		return nil, err
	}
	return signatureFrame("pawtalk-link-v2", server, v.ID, v.SourceProfileID, v.TargetProfileID, v.ChosenProfileID, v.SourceDeviceID, v.TargetDeviceID, v.SourceExchangeKey, v.TargetExchangeKey, strconv.FormatInt(v.SourceRevision, 10), strconv.FormatInt(v.TargetRevision, 10))
}
func verifyDeviceTranscriptTx(ctx context.Context, tx *sql.Tx, device, signature string, data []byte) error {
	sig, err := decodeFixed(signature, 64)
	if err != nil {
		return memberError(401, "INVALID_LINK_SIGNATURE")
	}
	var key []byte
	if err = tx.QueryRowContext(ctx, "SELECT signing_public_key FROM devices WHERE device_id=?", device).Scan(&key); err != nil {
		return err
	}
	if !ed25519.Verify(key, data, sig) {
		return memberError(401, "INVALID_LINK_SIGNATURE")
	}
	return nil
}

func (s *membershipStore) startLink(ctx context.Context, proof membershipProof, method, uri string, raw []byte, input memberLinkStart) (memberLink, error) {
	var result memberLink
	if !validHexID(input.RequestID, 32) || !validHexID(input.TokenHash, 64) {
		return result, memberError(400, "INVALID_LINK")
	}
	exchange, err := decodeFixed(input.ExchangeKey, 32)
	if err != nil {
		return result, memberError(400, "INVALID_LINK")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, "", "", false)
	if err != nil {
		return result, err
	}
	access, err := s.resolveAccessTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	main, revision, err := mainDeviceTx(ctx, tx, access.EffectiveProfileID)
	if err != nil {
		return result, err
	}
	if main != id.DeviceID {
		return result, memberError(403, "PRIMARY_DEVICE_REQUIRED")
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM device_link_requests WHERE target_profile_id=? AND state IN ('waiting','proposed','approved') AND expires_at>?", access.EffectiveProfileID, s.now().UnixMilli()).Scan(&count); err != nil {
		return result, err
	}
	if count >= 8 {
		return result, memberError(429, "LINK_LIMIT")
	}
	tokenHash, _ := hex.DecodeString(input.TokenHash)
	_, err = tx.ExecContext(ctx, "INSERT INTO device_link_requests(request_id,target_profile_id,target_main_device_id,target_exchange_key,target_revision,token_hash,expires_at,state) VALUES(?,?,?,?,?,?,?,'waiting')", input.RequestID, access.EffectiveProfileID, main, exchange, revision, tokenHash, s.now().UnixMilli()+membershipLinkSeconds*1000)
	if err != nil {
		return result, memberError(409, "LINK_CONFLICT")
	}
	result, err = s.loadLinkTx(ctx, tx, input.RequestID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *membershipStore) proposeLink(ctx context.Context, proof membershipProof, method, uri string, raw []byte, linkID string, input memberLinkProposal) (memberLink, error) {
	var result memberLink
	token, err := decodeFixed(input.Token, 32)
	if err != nil {
		return result, memberError(403, "INVALID_LINK")
	}
	digest := sha256.Sum256(token)
	exchange, err := decodeFixed(input.ExchangeKey, 32)
	if err != nil {
		return result, memberError(400, "INVALID_LINK")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var match int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM device_link_requests WHERE request_id=? AND token_hash=?", linkID, digest[:]).Scan(&match); err != nil {
		return result, err
	}
	if match != 1 {
		return result, memberError(403, "INVALID_LINK")
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	if result.State != "waiting" {
		return result, memberError(409, "LINK_CHANGED")
	}
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, input.Nickname, input.DeviceLabel, true)
	if err != nil {
		return result, err
	}
	source, err := resolvedProfileTx(ctx, tx, id.ProfileID)
	if err != nil {
		return result, err
	}
	if source == result.TargetProfileID {
		return result, memberError(409, "ALREADY_LINKED")
	}
	if err = s.memberBannedTx(ctx, tx, source); err != nil {
		return result, err
	}
	if err = s.memberBannedTx(ctx, tx, id.ProfileID); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO profile_controls(profile_id,primary_device_id) VALUES(?,?) ON CONFLICT(profile_id) DO NOTHING", source, id.DeviceID); err != nil {
		return result, err
	}
	main, revision, err := mainDeviceTx(ctx, tx, source)
	if err != nil {
		return result, err
	}
	if main != id.DeviceID {
		return result, memberError(403, "PRIMARY_DEVICE_REQUIRED")
	}
	targetMain, targetRevision, err := mainDeviceTx(ctx, tx, result.TargetProfileID)
	if err != nil {
		return result, err
	}
	if targetMain != result.TargetDeviceID || targetRevision != result.TargetRevision {
		return result, memberError(409, "GROUP_CHANGED")
	}
	if input.ChosenProfileID != source && input.ChosenProfileID != result.TargetProfileID {
		return result, memberError(400, "INVALID_MAIN_PROFILE")
	}
	result.SourceProfileID = source
	result.SourceDeviceID = id.DeviceID
	result.SourceRevision = revision
	result.SourceExchangeKey = input.ExchangeKey
	result.ChosenProfileID = input.ChosenProfileID
	frame, err := s.linkFrameTx(ctx, tx, result)
	if err != nil {
		return result, err
	}
	if err = verifyDeviceTranscriptTx(ctx, tx, id.DeviceID, input.Signature, frame); err != nil {
		return result, err
	}
	signature, _ := decodeFixed(input.Signature, 64)
	if _, err = tx.ExecContext(ctx, "UPDATE device_link_requests SET source_profile_id=?,source_main_device_id=?,source_exchange_key=?,source_revision=?,chosen_profile_id=?,source_proof=?,state='proposed' WHERE request_id=?", source, id.DeviceID, exchange, revision, input.ChosenProfileID, signature, linkID); err != nil {
		return result, err
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func linkEnvelopeFrame(domain string, transcript, envelope []byte) ([]byte, error) {
	a, b := sha256.Sum256(transcript), sha256.Sum256(envelope)
	return signatureFrame(domain, hex.EncodeToString(a[:]), hex.EncodeToString(b[:]))
}

func (s *membershipStore) approveLink(ctx context.Context, proof membershipProof, method, uri string, raw []byte, linkID string, input memberLinkApproval) (memberLink, error) {
	var result memberLink
	digest := sha256.Sum256(input.KeyEnvelope)
	packet, err := validateMemberPackage(input.KeyEnvelope, hex.EncodeToString(digest[:]))
	if err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, "", "", false)
	if err != nil {
		return result, err
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	if result.State != "proposed" || id.DeviceID != result.TargetDeviceID {
		return result, memberError(403, "PRIMARY_DEVICE_REQUIRED")
	}
	var configured string
	if err = tx.QueryRowContext(ctx, "SELECT e2ee_key_id FROM server_state WHERE id=1").Scan(&configured); err != nil {
		return result, err
	}
	if configured != packet.KeyID {
		return result, memberError(409, "KEY_ID_MISMATCH")
	}
	main, revision, err := mainDeviceTx(ctx, tx, result.TargetProfileID)
	if err != nil {
		return result, err
	}
	if main != id.DeviceID || revision != result.TargetRevision {
		return result, memberError(409, "GROUP_CHANGED")
	}
	access, err := s.resolveAccessTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if access.EffectiveProfileID != result.TargetProfileID {
		return result, memberError(409, "GROUP_CHANGED")
	}
	frame, err := s.linkFrameTx(ctx, tx, result)
	if err != nil {
		return result, err
	}
	approval, err := linkEnvelopeFrame("pawtalk-link-approval-v2", frame, input.KeyEnvelope)
	if err != nil {
		return result, err
	}
	if err = verifyDeviceTranscriptTx(ctx, tx, id.DeviceID, input.Signature, approval); err != nil {
		return result, err
	}
	sig, _ := decodeFixed(input.Signature, 64)
	if _, err = tx.ExecContext(ctx, "UPDATE device_link_requests SET state='approved',target_proof=?,key_envelope=? WHERE request_id=?", sig, []byte(input.KeyEnvelope), linkID); err != nil {
		return result, err
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *membershipStore) mergeLinkTx(ctx context.Context, tx *sql.Tx, v memberLink) error {
	var targetState string
	if err := tx.QueryRowContext(ctx, "SELECT state FROM memberships WHERE profile_id=?", v.TargetProfileID).Scan(&targetState); err != nil {
		return err
	}
	if targetState != "active" {
		return memberError(409, "GROUP_CHANGED")
	}
	for _, root := range []string{v.SourceProfileID, v.TargetProfileID} {
		profiles, err := groupProfilesTx(ctx, tx, root)
		if err != nil {
			return err
		}
		for _, p := range profiles {
			if err = s.memberBannedTx(ctx, tx, p); err != nil {
				return err
			}
		}
	}
	sourceMain, sourceRevision, err := mainDeviceTx(ctx, tx, v.SourceProfileID)
	if err != nil {
		return err
	}
	targetMain, targetRevision, err := mainDeviceTx(ctx, tx, v.TargetProfileID)
	if err != nil {
		return err
	}
	if sourceMain != v.SourceDeviceID || targetMain != v.TargetDeviceID || sourceRevision != v.SourceRevision || targetRevision != v.TargetRevision {
		return memberError(409, "GROUP_CHANGED")
	}
	var selectedAdmin int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM effective_profile_roles p JOIN roles r ON r.role_id=p.role_id WHERE p.profile_id=? AND r.system_kind='admin'", v.ChosenProfileID).Scan(&selectedAdmin); err != nil {
		return err
	}
	if selectedAdmin == 0 {
		for _, root := range []string{v.SourceProfileID, v.TargetProfileID} {
			if root != v.ChosenProfileID {
				if err = s.protectLastAdminTx(ctx, tx, root); err != nil {
					return err
				}
			}
		}
	}
	source, err := groupProfilesTx(ctx, tx, v.SourceProfileID)
	if err != nil {
		return err
	}
	target, err := groupProfilesTx(ctx, tx, v.TargetProfileID)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM profile_bindings WHERE target_profile_id IN (?,?)", v.SourceProfileID, v.TargetProfileID); err != nil {
		return err
	}
	now := s.now().UnixMilli()
	for _, profile := range append(source, target...) {
		state := "linked"
		if profile == v.ChosenProfileID {
			state = "active"
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO memberships(profile_id,state,joined_at) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET state=excluded.state,ended_at=NULL,revision=revision+1", profile, state, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO profile_roles(profile_id,role_id) SELECT ?,'member' WHERE NOT EXISTS(SELECT 1 FROM profile_roles WHERE profile_id=?)", profile, profile); err != nil {
			return err
		}
		if profile != v.ChosenProfileID {
			if _, err = tx.ExecContext(ctx, "INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", profile, v.ChosenProfileID, now); err != nil {
				return err
			}
		}
	}
	main := v.TargetDeviceID
	if v.ChosenProfileID == v.SourceProfileID {
		main = v.SourceDeviceID
	}
	if _, err = tx.ExecContext(ctx, "UPDATE profile_controls SET primary_device_id=?,revision=revision+1 WHERE profile_id=?", main, v.ChosenProfileID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM voice_slots WHERE profile_id IN (?,?) AND profile_id<>?", v.SourceProfileID, v.TargetProfileID, v.ChosenProfileID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE server_state SET revision=revision+1 WHERE id=1")
	return err
}

func (s *membershipStore) acceptLink(ctx context.Context, proof membershipProof, method, uri string, raw []byte, linkID, signature string) (memberLink, error) {
	var result memberLink
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, "", "", false)
	if err != nil {
		return result, err
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	if id.DeviceID != result.SourceDeviceID {
		return result, memberError(403, "PRIMARY_DEVICE_REQUIRED")
	}
	if result.State == "confirmed" {
		return result, tx.Commit()
	}
	if result.State != "approved" {
		return result, memberError(409, "LINK_CHANGED")
	}
	frame, err := s.linkFrameTx(ctx, tx, result)
	if err != nil {
		return result, err
	}
	accept, err := linkEnvelopeFrame("pawtalk-link-accept-v2", frame, result.KeyEnvelope)
	if err != nil {
		return result, err
	}
	if err = verifyDeviceTranscriptTx(ctx, tx, id.DeviceID, signature, accept); err != nil {
		return result, err
	}
	if err = s.mergeLinkTx(ctx, tx, result); err != nil {
		return result, err
	}
	sig, _ := decodeFixed(signature, 64)
	if _, err = tx.ExecContext(ctx, "UPDATE device_link_requests SET state='confirmed',final_proof=? WHERE request_id=?", sig, linkID); err != nil {
		return result, err
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *membershipStore) linkStatus(ctx context.Context, proof membershipProof, method, uri string, raw []byte, linkID string) (memberLink, error) {
	var result memberLink
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, "", "", false)
	if err != nil {
		return result, err
	}
	result, err = s.loadLinkTx(ctx, tx, linkID)
	if err != nil {
		return result, err
	}
	if id.DeviceID != result.SourceDeviceID && id.DeviceID != result.TargetDeviceID {
		return result, memberError(403, "FORBIDDEN")
	}
	// Display metadata is returned only to the two proven devices. The identity
	// and comparison code remain bound to the signed transcript, not the name.
	if result.SourceProfileID != "" {
		if err = tx.QueryRowContext(ctx, "SELECT nickname FROM profiles WHERE profile_id=?", result.SourceProfileID).Scan(&result.SourceNickname); err != nil {
			return result, err
		}
	}
	if err = tx.QueryRowContext(ctx, "SELECT nickname FROM profiles WHERE profile_id=?", result.TargetProfileID).Scan(&result.TargetNickname); err != nil {
		return result, err
	}
	return result, tx.Commit()
}
