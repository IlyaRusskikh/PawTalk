package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"pawtalk/server/internal/access"
)

// Migrated devices retain their policy membership, but API 2 did not enroll
// an agreement key. Only the authenticated original device can add its key.
func (p *protectedRuntime) migratedRecipientSession(token string) access.ResolveSession {
	return func(ctx context.Context, query access.SessionQuery) (access.Principal, error) {
		actor, err := p.resolveSession(token)(ctx, query)
		if err != nil {
			return actor, err
		}
		var migrated bool
		err = query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_runtime_activation' AND type='table')
			AND EXISTS(SELECT 1 FROM devices WHERE device_id=? AND original_profile_id=?)`, actor.DeviceID, actor.ProfileID).Scan(&migrated)
		if err == nil && !migrated {
			err = access.Inactive
		}
		return actor, err
	}
}

func (p *protectedRuntime) migratedRecipientHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resolve := p.migratedRecipientSession(memberBearer(r))
	if r.Method == http.MethodGet {
		tx, err := p.store.db.BeginTx(ctx, nil)
		if err != nil {
			protectedPolicyFail(w, err)
			return
		}
		defer tx.Rollback()
		actor, err := resolve(ctx, tx)
		var key string
		if err == nil {
			err = tx.QueryRowContext(ctx, `SELECT COALESCE(json_extract(snapshot, '$.KeyRecipients."' || ? || '".PublicKey'),'')
				FROM protected_policy WHERE id=1`, actor.DeviceID).Scan(&key)
		}
		if err != nil {
			protectedPolicyFail(w, err)
			return
		}
		respond(w, http.StatusOK, map[string]string{"publicKey": key})
		return
	}
	var draft access.PolicyDraft
	if _, err := decodeMemberJSON(w, r, 4096, &draft); err != nil {
		memberFail(w, err)
		return
	}
	if draft.Action != access.EnrollRecipientKey || !validHexID(draft.OperationID, 32) || !validHexID(draft.PublicKey, 64) ||
		draft.TextProjectionSeed != "" || draft.RoleUpdate != nil || draft.DeviceChange != nil || draft.ResourceChange != nil {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	preview := len(draft.Signature) == 0
	if preview && (draft.Revision != 0 || draft.PreviousDigest != "" || draft.ResultDigest != "" ||
		draft.TextProjectionRoot != "" || draft.TextProjectionVersion != 0) ||
		!preview && (!validHexID(draft.TextProjectionRoot, 64) || !access.HasTextRecipientProjection(draft.TextProjectionVersion)) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	actor, err := resolve(ctx, p.store.db)
	var seed []byte
	if err == nil {
		err = p.store.db.QueryRowContext(ctx, "SELECT identity_seed FROM server_state WHERE id=1").Scan(&seed)
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	defer clear(seed)
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte("pawtalk-migrated-recipient-projection-v1:" + actor.DeviceID + ":" + draft.OperationID))
	draft.TextProjectionSeed = hex.EncodeToString(mac.Sum(nil))
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	if preview {
		result, err := store.PreviewPolicy(ctx, resolve, draft)
		if err != nil {
			protectedPolicyFail(w, err)
			return
		}
		result.TextProjectionSeed = ""
		respond(w, http.StatusOK, result)
		return
	}
	proof, err := store.CommitPolicy(ctx, resolve, verifyProtectedPolicyDraft, draft)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]string{"digest": proof.Digest})
}
