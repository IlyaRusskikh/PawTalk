package access

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeleteOwnMessageDuringTimeoutKeepsSendReceipt(t *testing.T) {
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	state := testPolicyState()
	reader := state.Members["reader"]
	reader.TimeoutUntil = time.Now().Add(time.Hour).UnixMilli()
	state.Members[reader.ID] = reader
	state.Roles["reader"] = Role{Grants: []string{"history.full", "message.send"}}
	state.PolicyDevices = make(map[string]PolicyDevice)
	state.KeyRecipients = make(map[string]KeyRecipient)
	actors := make(map[string]Principal)
	for profile, seed := range map[string]byte{"owner": 21, "reader": 23} {
		keyBytes := make([]byte, 32)
		keyBytes[0] = seed
		key := hex.EncodeToString(keyBytes)
		sum := sha256.Sum256(keyBytes)
		device := hex.EncodeToString(sum[:])
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: key}
		state.KeyRecipients[device] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: key}
		actors[profile] = Principal{ProfileID: profile, DeviceID: device}
	}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actors[profile], nil }
	}
	draft, err := store.PreviewPolicy(ctx, resolve("owner"), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	if err != nil {
		t.Fatal(err)
	}
	draft.Signature = make([]byte, 64)
	verifyPolicy := func(context.Context, SessionQuery, Principal, PolicyDraft) error { return nil }
	if _, err := store.CommitPolicy(ctx, resolve("owner"), verifyPolicy, draft); err != nil {
		t.Fatal(err)
	}
	attempt := MessageAttempt{ChannelID: "public", OperationID: strings.Repeat("b", 32), KeyID: strings.Repeat("c", 64),
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64)}
	device := actors["reader"].DeviceID
	if _, err := db.ExecContext(ctx, `INSERT INTO protected_message_receipts
		(channel_id,position,device_id,profile_id,operation_id,key_id,sent_at,nonce) VALUES('public',8,?,'reader',?,?,?,?)`,
		device, attempt.OperationID, attempt.KeyID, reader.TimeoutUntil-1000, attempt.Nonce); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO protected_messages
		(channel_id,position,device_id,profile_id,operation_id,key_id,nonce,ciphertext,signature)
		VALUES('public',8,?,'reader',?,?,?,?,?)`, device, attempt.OperationID, attempt.KeyID,
		attempt.Nonce, attempt.Ciphertext, attempt.Signature); err != nil {
		t.Fatal(err)
	}
	verify := func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error { return nil }
	newAttempt := attempt
	newAttempt.OperationID = strings.Repeat("d", 32)
	if _, err := store.AppendMessage(ctx, resolve("reader"), verify, newAttempt, false); !errors.Is(err, TimedOut) {
		t.Fatalf("time-out did not block a new send: %v", err)
	}
	if err := store.DeleteMessage(ctx, resolve("reader"), nil, "public", 8); err != nil {
		t.Fatal(err)
	}
	receipt, err := store.AppendMessage(ctx, resolve("reader"), verify, attempt, false)
	if err != nil || !receipt.Existing || receipt.Position != 8 {
		t.Fatalf("retry after deletion: %+v, %v", receipt, err)
	}
	var retained bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM protected_messages WHERE position=8)").Scan(&retained); err != nil || retained {
		t.Fatalf("retained deleted ciphertext = %v, %v", retained, err)
	}
}
