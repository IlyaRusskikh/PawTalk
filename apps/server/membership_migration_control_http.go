package main

import (
	"bytes"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"net/http"
)

type migrationControlRequest struct {
	DeviceID      string          `json:"deviceId"`
	Nonce         string          `json:"nonce"`
	ArchiveSHA256 string          `json:"archiveSha256"`
	Payload       json.RawMessage `json:"payload,omitempty"`
	Signature     string          `json:"signature"`
}

func (a *protectedMigrationAPI) migrationControl(dir, action string, w http.ResponseWriter, r *http.Request) {
	var request migrationControlRequest
	if _, err := decodeMemberJSON(w, r, 2048, &request); err != nil {
		memberFail(w, err)
		return
	}
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_PROOF")
	signature, err := decodeFixed(request.Signature, ed25519.SignatureSize)
	if err != nil || !validHexID(request.DeviceID, 64) || !validHexID(request.Nonce, 64) ||
		!validHexID(request.ArchiveSHA256, 64) || (action == "report") != (len(request.Payload) == 0) {
		memberFail(w, invalid)
		return
	}
	ctx := r.Context()
	tx, err := a.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		memberFail(w, err)
		return
	}
	authority, err := a.authorizeChallenge(ctx, tx, request.Nonce, request.DeviceID, signature, func(serverID string) ([]byte, error) {
		return signatureFrame("pawtalk-migration-control-v1", serverID, request.DeviceID, request.Nonce,
			request.ArchiveSHA256, action, publicKeyID(request.Payload))
	})
	_ = tx.Rollback()
	if err != nil {
		memberFail(w, err)
		return
	}
	if authority.archiveSHA256 != request.ArchiveSHA256 {
		memberFail(w, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED"))
		return
	}
	body := bytes.NewReader(request.Payload)
	var result any
	switch action {
	case "report":
		result, err = verifyStandaloneMigrationImport(ctx, dir, authority.archiveSHA256)
	case "approve-import":
		result, err = approveStandaloneMigrationImport(ctx, dir, authority.archiveSHA256, body)
	case "stage-policy":
		result, err = stageStandaloneMigrationPolicy(ctx, dir, authority.archiveSHA256, body)
	case "approve-cutover":
		result, err = approveStandaloneMigrationCutover(ctx, dir, authority.archiveSHA256, body)
	default:
		err = invalid
	}
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}
