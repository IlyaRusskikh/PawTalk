package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"strconv"
)

type memberControlInput struct {
	NewDeviceID      string `json:"newDeviceId"`
	RequestID        string `json:"requestId"`
	ExpectedRevision int64  `json:"expectedRevision"`
	OldSignature     string `json:"oldSignature"`
	NewSignature     string `json:"newSignature"`
}

func (s *membershipStore) transferControl(ctx context.Context, token string, input memberControlInput) error {
	if !validHexID(input.NewDeviceID, 64) || input.ExpectedRevision < 1 {
		return memberError(400, "INVALID_DEVICE")
	}
	payload, _ := signatureFrame(input.NewDeviceID, strconv.FormatInt(input.ExpectedRevision, 10), input.OldSignature, input.NewSignature)
	return s.mutate(ctx, token, input.RequestID, "control.transfer", "", payload, func(tx *sql.Tx, access memberAccess) error {
		main, revision, err := mainDeviceTx(ctx, tx, access.EffectiveProfileID)
		if err != nil {
			return err
		}
		if main != access.DeviceID {
			return memberError(403, "PRIMARY_DEVICE_REQUIRED")
		}
		if revision != input.ExpectedRevision {
			return memberError(409, "GROUP_CHANGED")
		}
		var newProfile, server string
		err = tx.QueryRowContext(ctx, "SELECT original_profile_id FROM devices WHERE device_id=?", input.NewDeviceID).Scan(&newProfile)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "DEVICE_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		root, err := resolvedProfileTx(ctx, tx, newProfile)
		if err != nil {
			return err
		}
		if root != access.EffectiveProfileID {
			return memberError(403, "DEVICE_NOT_IN_GROUP")
		}
		if err = s.memberBannedTx(ctx, tx, newProfile); err != nil {
			return err
		}
		if err = tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&server); err != nil {
			return err
		}
		data, err := signatureFrame("pawtalk-control-v2", server, access.EffectiveProfileID, main, input.NewDeviceID, strconv.FormatInt(revision, 10), input.RequestID)
		if err != nil {
			return err
		}
		if err = verifyDeviceTranscriptTx(ctx, tx, main, input.OldSignature, data); err != nil {
			return err
		}
		if err = verifyDeviceTranscriptTx(ctx, tx, input.NewDeviceID, input.NewSignature, data); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE profile_controls SET primary_device_id=?,revision=revision+1 WHERE profile_id=?", input.NewDeviceID, access.EffectiveProfileID)
		return err
	})
}

func (s *membershipStore) unlinkDevice(ctx context.Context, proof membershipProof, method, uri string, raw []byte, targetDevice, requestID string, revoke bool) error {
	if !validHexID(targetDevice, 64) || !validHexID(requestID, 32) {
		return memberError(400, "INVALID_DEVICE")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	actor, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, "", "", false)
	if err != nil {
		return err
	}
	action := "device.unlink"
	if revoke {
		action = "device.revoke"
	}
	hash := sha256.Sum256(raw)
	var oldAction string
	var oldHash []byte
	err = tx.QueryRowContext(ctx, "SELECT action,payload_hash FROM mutation_receipts WHERE device_id=? AND request_id=?", actor.DeviceID, requestID).Scan(&oldAction, &oldHash)
	if err == nil {
		if oldAction != action || !bytes.Equal(oldHash, hash[:]) {
			return memberError(409, "REQUEST_CONFLICT")
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var targetProfile string
	err = tx.QueryRowContext(ctx, "SELECT original_profile_id FROM devices WHERE device_id=?", targetDevice).Scan(&targetProfile)
	if errors.Is(err, sql.ErrNoRows) {
		return memberError(404, "DEVICE_NOT_FOUND")
	}
	if err != nil {
		return err
	}
	root, err := resolvedProfileTx(ctx, tx, targetProfile)
	if err != nil {
		return err
	}
	actorRoot, err := resolvedProfileTx(ctx, tx, actor.ProfileID)
	if err != nil {
		return err
	}
	main, _, err := mainDeviceTx(ctx, tx, root)
	if err != nil {
		return err
	}
	if actorRoot != root || (actor.DeviceID != main && actor.DeviceID != targetDevice) {
		return memberError(403, "PRIMARY_DEVICE_REQUIRED")
	}
	if revoke && actor.DeviceID != main {
		return memberError(403, "PRIMARY_DEVICE_REQUIRED")
	}
	var others int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM profile_bindings WHERE target_profile_id=?", root).Scan(&others); err != nil {
		return err
	}
	if main == targetDevice && others > 0 {
		return memberError(409, "TRANSFER_CONTROL_FIRST")
	}
	var groupState string
	if err = tx.QueryRowContext(ctx, "SELECT state FROM memberships WHERE profile_id=?", root).Scan(&groupState); errors.Is(err, sql.ErrNoRows) {
		groupState = "left"
	} else if err != nil {
		return err
	}
	if revoke && targetProfile == root && others == 0 {
		if err = s.protectLastAdminTx(ctx, tx, root); err != nil {
			return err
		}
	}
	if targetProfile == root && others > 0 {
		if _, err = s.rebaseGroupTx(ctx, tx, root, targetDevice, groupState); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM profile_bindings WHERE source_profile_id=?", targetProfile); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM group_roles WHERE profile_id=?", targetProfile); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM group_profiles WHERE profile_id=?", targetProfile); err != nil {
		return err
	}
	state := "left"
	if groupState == "active" {
		state = "active"
	}
	if revoke {
		state = "revoked"
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO memberships(profile_id,state,joined_at) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET state=excluded.state,revision=revision+1", targetProfile, state, s.now().UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO profile_controls(profile_id,primary_device_id) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET primary_device_id=excluded.primary_device_id,revision=revision+1", targetProfile, targetDevice); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE profile_controls SET revision=revision+1 WHERE profile_id=?", root); err != nil {
		return err
	}
	if revoke {
		if _, err = tx.ExecContext(ctx, "UPDATE sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL", s.now().UnixMilli(), targetDevice); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM voice_slots WHERE session_id IN(SELECT session_id FROM sessions WHERE device_id=?)", targetDevice); err != nil {
			return err
		}
	} else {
		if _, err = tx.ExecContext(ctx, "UPDATE voice_slots SET profile_id=? WHERE session_id IN(SELECT session_id FROM sessions WHERE device_id=?)", targetProfile, targetDevice); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO mutation_receipts(device_id,request_id,action,payload_hash,created_at) VALUES(?,?,?,?,?)", actor.DeviceID, requestID, action, hash[:], s.now().UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE server_state SET revision=revision+1 WHERE id=1"); err != nil {
		return err
	}
	return tx.Commit()
}

// Keep group presentation/authority independent from a departed original owner.
// Original per-device assignments are never overwritten by this operation.
func (s *membershipStore) rebaseGroupTx(ctx context.Context, tx *sql.Tx, oldRoot, removedDevice, state string) (string, error) {
	main, revision, err := mainDeviceTx(ctx, tx, oldRoot)
	if err != nil {
		return "", err
	}
	if main == removedDevice {
		return "", memberError(409, "TRANSFER_CONTROL_FIRST")
	}
	var nextRoot string
	if err = tx.QueryRowContext(ctx, "SELECT original_profile_id FROM devices WHERE device_id=?", main).Scan(&nextRoot); err != nil {
		return "", err
	}
	group, err := groupProfilesTx(ctx, tx, oldRoot)
	if err != nil {
		return "", err
	}
	var name, avatarOwner string
	var avatar []byte
	var displayRevision int64
	if err = tx.QueryRowContext(ctx, "SELECT nickname,avatar_envelope,avatar_profile_id,revision FROM effective_profiles WHERE profile_id=?", oldRoot).Scan(&name, &avatar, &avatarOwner, &displayRevision); err != nil {
		return "", err
	}
	var nextRevision int64
	if err = tx.QueryRowContext(ctx, "SELECT revision FROM effective_profiles WHERE profile_id=?", nextRoot).Scan(&nextRevision); err != nil {
		return "", err
	}
	if nextRevision > displayRevision {
		displayRevision = nextRevision
	}
	displayRevision++
	rows, err := tx.QueryContext(ctx, "SELECT role_id FROM effective_profile_roles WHERE profile_id=?", oldRoot)
	if err != nil {
		return "", err
	}
	roles := []string{}
	for rows.Next() {
		var role string
		if err = rows.Scan(&role); err != nil {
			rows.Close()
			return "", err
		}
		roles = append(roles, role)
	}
	if err = closeMemberRows(rows); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM group_roles WHERE profile_id IN (?,?)", oldRoot, nextRoot); err != nil {
		return "", err
	}
	for _, role := range roles {
		if _, err = tx.ExecContext(ctx, "INSERT INTO group_roles(profile_id,role_id) VALUES(?,?)", nextRoot, role); err != nil {
			return "", err
		}
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM group_profiles WHERE profile_id IN (?,?)", oldRoot, nextRoot); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO group_profiles(profile_id,nickname,avatar_envelope,avatar_profile_id,revision) VALUES(?,?,?,?,?)", nextRoot, name, avatar, avatarOwner, displayRevision); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM profile_bindings WHERE target_profile_id=?", oldRoot); err != nil {
		return "", err
	}
	for _, profile := range group {
		if profile == oldRoot {
			continue
		}
		memberState := state
		if state == "active" {
			memberState = "linked"
			if profile == nextRoot {
				memberState = "active"
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE memberships SET state=?,revision=revision+1 WHERE profile_id=?", memberState, profile); err != nil {
			return "", err
		}
		if profile != nextRoot {
			if _, err = tx.ExecContext(ctx, "INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", profile, nextRoot, s.now().UnixMilli()); err != nil {
				return "", err
			}
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO profile_controls(profile_id,primary_device_id,revision) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET primary_device_id=excluded.primary_device_id,revision=excluded.revision", nextRoot, main, revision+1); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE voice_slots SET profile_id=? WHERE profile_id=? AND session_id NOT IN(SELECT session_id FROM sessions WHERE device_id=?)", nextRoot, oldRoot, removedDevice); err != nil {
		return "", err
	}
	return nextRoot, nil
}
