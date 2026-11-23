package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

// This acceptance test seeds completed work outside the measurement. It runs
// a real invite, epoch publication, and decrypts the oldest message over TLS.
func TestProtectedArchiveFullHistoryInvitationWorkBound(t *testing.T) {
	probeResume := os.Getenv("PAWTALK_TEST_ARCHIVE_RESUME") == "1"
	if os.Getenv("PAWTALK_TEST_ARCHIVE_SCALE") != "1" && !probeResume {
		t.Skip("set PAWTALK_TEST_ARCHIVE_SCALE=1 for KEY-16 or PAWTALK_TEST_ARCHIVE_RESUME=1 to also measure KEY-17")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	const generations = 10_000
	channel := strings.Repeat("a", 32)
	server := testMembershipStore(t)
	policy, _, owner, _ := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles[access.Everyone] = access.Role{Grants: []string{access.ChannelView, "history.full"}}
		for id := range state.Members {
			if id != state.Owner {
				delete(state.Members, id)
			}
		}
		for id, device := range state.PolicyDevices {
			if device.ProfileID != state.Owner {
				delete(state.PolicyDevices, id)
				delete(state.KeyRecipients, id)
			}
		}
		state.Channels[channel] = state.Channels["private"]
		delete(state.Channels, "private")
	})
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	preview, err := policy.PreviewPolicyForTransport(ctx, server.protectedSession(owner.Token), access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview.Draft))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("b", 64)
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("c", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	challenge, err := runtime.issueSessionChallenge()
	if err != nil {
		t.Fatal(err)
	}
	device := owner.Access.DeviceID
	frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, server.protectedBinding, challenge.Nonce, device)
	if err != nil {
		t.Fatal(err)
	}
	session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce,
		Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(1).device, frame))})
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-archive-scale-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"policyTrust": map[string]string{"serverId": serverID, "cutoverDigest": runtime.cutoverDigest,
		"anchorDigest": anchor.Digest, "ownerProfileId": session.ProfileID, "ownerDeviceId": device}, "channelId": channel,
		"generations": generations, "initialPolicyDigest": anchor.Draft.ResultDigest,
		"owner": map[string]string{"profileId": session.ProfileID, "deviceId": device, "token": session.Token, "publicKey": testRecipientKey(t, 11)}}
	if probeResume {
		input["additionalMessageGenerations"] = []uint64{2500, 5000}
	}
	seedInput, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	messages := seedProtectedArchiveScale(t, ctx, server.db, node, script, seedInput, generations, testRecipientKey(t, 11))
	for index, message := range messages {
		setScaleArchiveHeads(t, ctx, server.db, policy, channel, message.Generation)
		if receipt, err := server.appendProtectedMessage(ctx, session.Token, message.Packet); err != nil || receipt.Position != uint64(index+1) {
			t.Fatalf("append generation %d signed, encrypted message: %+v, %v", message.Generation, receipt, err)
		}
	}
	setScaleArchiveHeads(t, ctx, server.db, policy, channel, generations)

	mux := http.NewServeMux()
	// The archive traversal measures content work, not elapsed time under the
	// per-IP quota. This route retains the real archive handler, authenticated
	// policy checks, Merkle/signature evidence and TLS. Other routes use the
	// normal runtime and rate limiter, including the measured inviter.
	mux.HandleFunc("GET /api/v3/keys/archive/{channel}/links/{key}", runtime.archiveLinksHTTP)
	mux.Handle("/", runtime.handler())
	room := httptest.NewTLSServer(mux)
	defer room.Close()
	input["base"] = room.URL
	input["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: room.Certificate().Raw}))
	input["fingerprint"] = publicKeyID(room.Certificate().Raw)
	request, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	args := []string{script}
	if probeResume {
		args = append([]string{"--expose-gc"}, args...)
	}
	command := exec.CommandContext(ctx, node, args...)
	hideWindow(command)
	command.Stdin = bytes.NewReader(request)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("archive acceptance: %v\n%s", err, output)
	}
	if !json.Valid(output) {
		t.Fatalf("archive metrics are malformed: %s", output)
	}
	t.Logf("KEY-16 %s", output)
}

type scaleArchiveMessage struct {
	Generation uint64
	Packet     access.MessageAttempt
}

func seedProtectedArchiveScale(t *testing.T, ctx context.Context, db *sql.DB, node, script string, input []byte,
	generations int, publicKey string) []scaleArchiveMessage {
	t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	command := exec.CommandContext(ctx, node, script, "seed")
	hideWindow(command)
	command.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = command.Wait() }()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	epoch, err := tx.PrepareContext(ctx, `INSERT INTO protected_epochs(channel_id,purpose,generation,key_id,task_id,digest,record) VALUES(?,?,?,?,?,?,?)`)
	if err != nil {
		t.Fatal(err)
	}
	defer epoch.Close()
	pack, err := tx.PrepareContext(ctx, `INSERT INTO protected_epoch_packages(channel_id,generation,recipient_id,recipient_key,purpose,ciphertext) VALUES(?,?,?,?,?,?)`)
	if err != nil {
		t.Fatal(err)
	}
	defer pack.Close()
	link, err := tx.PrepareContext(ctx, `INSERT INTO protected_archive_links(channel_id,archive_generation,purpose,target_generation,target_key_id,ciphertext) VALUES(?,?,?,?,?,?)`)
	if err != nil {
		t.Fatal(err)
	}
	defer link.Close()
	var messages []scaleArchiveMessage
	scanner := bufio.NewScanner(stdout)
	rows := 0
	for scanner.Scan() {
		var row struct {
			Message *scaleArchiveMessage
			Proof   access.EpochProof
			Package access.EpochPackage
			Links   []access.ArchiveLink
		}
		if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		if row.Message != nil {
			messages = append(messages, *row.Message)
			continue
		}
		record := row.Proof.Record
		raw, err := json.Marshal(row.Proof)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := epoch.ExecContext(ctx, record.ChannelID, record.Purpose, record.Generation, record.KeyID, record.TaskID, publicKeyID(record.Signature), raw); err != nil {
			t.Fatal(err)
		}
		if _, err := pack.ExecContext(ctx, record.ChannelID, record.Generation, row.Package.RecipientID, publicKey, record.Purpose, row.Package.Ciphertext); err != nil {
			t.Fatal(err)
		}
		for _, target := range row.Links {
			if _, err := link.ExecContext(ctx, record.ChannelID, record.Generation, target.Purpose, target.Generation, target.KeyID, target.Ciphertext); err != nil {
				t.Fatal(err)
			}
		}
		rows++
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("seed archive: %v\n%s", err, stderr.Bytes())
	}
	if rows != generations*2 || len(messages) == 0 {
		t.Fatalf("incomplete archive seed: %d rows", rows)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_rotation_tasks"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return messages
}

func setScaleArchiveHeads(t *testing.T, ctx context.Context, db *sql.DB, policy *access.Store, channel string, generation uint64) {
	t.Helper()
	state, _, err := policy.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	state.EpochWindows = map[string]access.EpochWindow{channel: {Current: generation}}
	state.ArchiveHeads = map[string]uint64{channel: generation}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", raw); err != nil {
		t.Fatal(err)
	}
}
