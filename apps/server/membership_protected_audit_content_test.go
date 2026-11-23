package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedAuditContentMinimizationAcrossTLSAndSQLite(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	server, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer server.db.Close()
	const (
		channel     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		channelName = "Published channel title AUDIT03"
		message     = "Private message contents AUDIT03"
		filename    = "private-attachment-AUDIT03.bin"
		attachment  = "Private attachment bytes AUDIT03"
	)
	_, _, owner, _ := protectedTestStateWith(t, server, func(state *access.State) {
		delete(state.Channels, "private")
		state.Channels[channel] = access.Channel{Kind: "text", NextPosition: 1, Settings: &access.ChannelSettings{Name: channelName}}
	})
	draft, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, draft))
	if err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("9", 64)
	cutover := strings.Repeat("c", 64)
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: cutover,
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	challenge, err := runtime.issueSessionChallenge()
	if err != nil {
		t.Fatal(err)
	}
	device := owner.Access.DeviceID
	frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, cutover, server.protectedBinding, challenge.Nonce, device)
	if err != nil {
		t.Fatal(err)
	}
	session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce,
		Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(1).device, frame))})
	if err != nil {
		t.Fatal(err)
	}
	var serverLog bytes.Buffer
	room := httptest.NewUnstartedServer(runtime.handler())
	room.Config.ErrorLog = log.New(&serverLog, "", 0)
	room.StartTLS()
	defer room.Close()

	recoveryCode := bytes.Repeat([]byte{90}, 32)
	input, err := json.Marshal(map[string]any{
		"base": room.URL, "serverId": serverID, "channelId": channel, "channelName": channelName,
		"owner": session, "message": message, "filename": filename, "attachment": attachment,
		"recoveryCode": b64.EncodeToString(recoveryCode),
		"certificate":  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: room.Certificate().Raw})),
		"fingerprint":  publicKeyID(room.Certificate().Raw),
		"policyTrust": map[string]string{"serverId": serverID, "anchorDigest": anchor.Digest, "cutoverDigest": cutover,
			"ownerProfileId": owner.Access.EffectiveProfileID, "ownerDeviceId": device},
	})
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join("..", "client", "windows", "scripts", "protected-audit-content-integration.cjs")
	command := exec.CommandContext(ctx, node, script)
	hideWindow(command)
	var clientLog bytes.Buffer
	command.Stdin, command.Stderr = bytes.NewReader(input), &clientLog
	output, err := command.Output()
	if err != nil {
		t.Fatalf("audit content client integration: %v\n%s", err, clientLog.Bytes())
	}
	room.Close()

	var result struct {
		AttachmentID      string `json:"attachmentId"`
		RecoveryID        string `json:"recoveryId"`
		LiveKey           string `json:"liveKey"`
		RecoverySigning   string `json:"recoverySigning"`
		RecoveryAgreement string `json:"recoveryAgreement"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	liveKey, err := hex.DecodeString(result.LiveKey)
	if err != nil || len(liveKey) != 32 || !validHexID(result.AttachmentID, 32) || !validHexID(result.RecoveryID, 64) {
		t.Fatal("client did not return a valid synthetic observation")
	}
	defer clear(liveKey)
	recoverySigning, signingErr := hex.DecodeString(result.RecoverySigning)
	recoveryAgreement, agreementErr := hex.DecodeString(result.RecoveryAgreement)
	if signingErr != nil || agreementErr != nil || len(recoverySigning) != 32 || len(recoveryAgreement) != 32 {
		t.Fatal("client did not return valid synthetic recovery key observations")
	}
	defer clear(recoverySigning)
	defer clear(recoveryAgreement)
	dbFile, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	wal, err := os.ReadFile(path + "-wal")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if !bytes.Contains(dbFile, []byte(channelName)) && !bytes.Contains(wal, []byte(channelName)) {
		t.Fatal("inspection did not find the permitted channel title in SQLite")
	}
	if !bytes.Contains(dbFile, []byte(result.RecoveryID)) && !bytes.Contains(wal, []byte(result.RecoveryID)) {
		t.Fatal("inspection did not find the public recovery identity in SQLite")
	}
	for _, source := range []struct {
		name string
		data []byte
	}{
		{"SQLite", dbFile}, {"SQLite WAL", wal}, {"HTTP server log", serverLog.Bytes()}, {"client process stderr", clientLog.Bytes()},
	} {
		for _, marker := range []struct {
			name string
			data []byte
		}{
			{"message plaintext", []byte(message)}, {"private filename", []byte(filename)},
			{"attachment plaintext", []byte(attachment)}, {"unwrapped live key", liveKey},
			{"recovery code", recoveryCode}, {"recovery signing key", recoverySigning}, {"recovery agreement key", recoveryAgreement},
		} {
			for _, representation := range [][]byte{
				marker.data, []byte(hex.EncodeToString(marker.data)),
				[]byte(base64.StdEncoding.EncodeToString(marker.data)), []byte(b64.EncodeToString(marker.data)),
			} {
				if bytes.Contains(source.data, representation) {
					t.Errorf("%s exposed %s", source.name, marker.name)
				}
			}
		}
	}
}
