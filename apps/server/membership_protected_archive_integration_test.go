package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedArchiveClientResumesHistoryThroughServer(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	server := testMembershipStore(t)
	baseTime := server.now()
	var elapsed atomic.Int64
	server.now = func() time.Time { return baseTime.Add(time.Duration(elapsed.Load())) }
	channel := strings.Repeat("a", 32)
	probeChannel := strings.Repeat("b", 32)
	voiceProbeChannel := strings.Repeat("c", 32)
	hiddenProbeChannel := "b" + strings.Repeat("f", 31)
	probeCategory := strings.Repeat("d", 32)
	store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		probe := state.Channels["private"]
		probe.CategoryID = probeCategory
		state.Categories = map[string]access.ACL{probeCategory: {}}
		state.Channels[probeChannel] = probe
		state.Channels[voiceProbeChannel] = access.Channel{Kind: "voice", CategoryID: probeCategory, NextPosition: 1}
		probe.CategoryID = ""
		role := state.Roles["reader"]
		role.Grants = append(role.Grants, "channel.edit")
		state.Roles["reader"] = role
		for profile := range state.Members {
			if profile != state.Owner {
				probe.ACL.Profiles = map[string]access.Overwrite{profile: {Deny: []string{"channel.edit"}}}
				state.Channels[hiddenProbeChannel] = access.Channel{Kind: "voice", CategoryID: probeCategory, NextPosition: 1,
					ACL: access.ACL{Profiles: map[string]access.Overwrite{profile: {Deny: []string{access.ChannelView}}}}}
			}
		}
		state.Channels[channel] = probe
		delete(state.Channels, "private")
	})
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("c", 64), challenges: make(map[string]int64)}
	protectedHandler := runtime.handler()
	revisionHandler := runtime.handler()
	attestationHandler := runtime.handler()
	historyWindowHandler := runtime.handler()
	room := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/revision/") {
			revisionHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/window/") {
			historyWindowHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/policy/attestations") || strings.HasPrefix(r.URL.Path, "/api/v3/policy/text-channel/") ||
			r.URL.Query().Get("scoped") == "1" {
			attestationHandler.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/v3/history/imported/"+channel {
			// This fixture starts on API 3 and has no migration rows.
			var sent bool
			err := store.DispatchHistory(r.Context(), runtime.resolveSession(memberBearer(r)), channel,
				func(_ *sql.Conn, first, _ uint64) error {
					return writeProtectedDelivery(w, &sent, importedProtectedPage{First: first, Messages: []importedProtectedMessage{}})
				})
			if err != nil && !sent {
				protectedRuntimeFail(w, err)
			}
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/") {
			protectedHandler.ServeHTTP(w, r)
			return
		}
		var body struct {
			After    int64
			Purpose  string
			From     uint64
			Through  uint64
			KeyID    string
			Record   access.EpochRecord
			Target   access.ArchiveTarget
			Packages []access.EpochPackage
			Links    []access.ArchiveLink
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		token := memberBearer(r)
		var result any
		var err error
		switch r.URL.Path {
		case "/policy":
			if _, err := runtime.resolveSession(token)(r.Context(), server.db); err != nil {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			result, err = store.PolicyProofPage(r.Context(), body.After)
		case "/claim":
			result, err = server.claimProtectedRotation(r.Context(), token, channel, body.Purpose)
		case "/epochs":
			result, err = server.loadProtectedEpochProofPage(r.Context(), token, channel, body.Purpose, body.From, body.Through)
		case "/target":
			result, err = server.loadProtectedRotationTarget(r.Context(), token, body.Record, body.Target)
		case "/commit":
			err = server.commitProtectedEpoch(r.Context(), token, body.Record, body.Packages, body.Links...)
		case "/head":
			result, err = server.loadProtectedEpochPackage(r.Context(), token, channel, body.KeyID, access.ArchiveEpoch)
		case "/live":
			result, err = server.loadProtectedEpochPackage(r.Context(), token, channel, body.KeyID, access.LiveEpoch)
		case "/links":
			result, err = server.loadProtectedArchiveLinks(r.Context(), token, channel, body.KeyID)
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		respond(w, http.StatusOK, result)
	}))
	defer room.Close()

	session := func(member memberSession, seed byte) map[string]string {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		deviceID := member.Access.DeviceID
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, server.protectedBinding, challenge.Nonce, deviceID)
		if err != nil {
			t.Fatal(err)
		}
		token, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: deviceID, Nonce: challenge.Nonce,
			Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return map[string]string{
			"token": token.Token, "profileId": member.Access.EffectiveProfileID, "deviceId": deviceID,
			"publicKey": state.KeyRecipients[deviceID].PublicKey,
		}
	}
	policyToken := owner.Token
	commitPolicy := func(draft access.PolicyDraft) access.PolicyProof {
		t.Helper()
		preview, err := store.PreviewPolicyForTransport(ctx, server.protectedSession(policyToken), draft)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := server.commitProtectedPolicy(ctx, policyToken, signTestPolicyDraft(t, server, owner, 1, preview.Draft))
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commitPolicy(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: fmt.Sprintf("%032x", 1)})
	server.protectedBinding = strings.Repeat("b", 64)
	runtime.anchorDigest = anchor.Digest
	ownerSession, readerSession := session(owner, 1), session(reader, 2)
	policyToken = ownerSession["token"]
	trust := map[string]string{"serverId": serverID, "anchorDigest": anchor.Digest,
		"ownerProfileId": owner.Access.EffectiveProfileID, "ownerDeviceId": owner.Access.DeviceID}
	script, err := filepath.Abs("../client/windows/scripts/protected-archive-session-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	type checkpoint struct {
		KeyID      string `json:"keyId"`
		Generation uint64 `json:"generation"`
		Through    uint64 `json:"through"`
	}
	var first checkpoint
	var firstDelivery, firstMessagePacket, readerEpochs json.RawMessage
	for step := 1; step <= 4; step++ {
		if step == 1 {
			elapsed.Add(int64(6 * time.Second))
		} else {
			// Each phase represents a separate round of client activity.
			elapsed.Add(int64(time.Minute))
		}
		if step > 1 {
			grants := []string{access.ChannelView, "message.pin"}
			if step != 2 {
				grants = append(grants, "message.send")
			}
			if step == 3 {
				state.Roles["reader"] = access.Role{}
				commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 9),
					RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
			}
			if step == 4 {
				grants = append(grants, "history.full")
			}
			state.Roles["reader"] = access.Role{Grants: grants}
			commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", step),
				RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
			if step == 3 {
				elapsed.Add(int64(6 * time.Second))
			}
		}
		payload, err := json.Marshal(map[string]any{
			"step": step, "base": room.URL, "policyTrust": trust, "channelId": channel, "probeChannel": probeChannel,
			"voiceProbeChannel": voiceProbeChannel, "hiddenProbeChannel": hiddenProbeChannel, "probeCategory": probeCategory,
			"certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: room.Certificate().Raw})),
			"fingerprint": publicKeyID(room.Certificate().Raw),
			"owner":       ownerSession, "reader": readerSession, "firstLive": first,
			"firstDelivery": firstDelivery, "firstMessagePacket": firstMessagePacket, "readerEpochs": readerEpochs,
		})
		if err != nil {
			t.Fatal(err)
		}
		command := exec.CommandContext(ctx, node, script)
		hideWindow(command)
		command.Stdin = bytes.NewReader(payload)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("archive integration step %d: %v\n%s", step, err, output)
		}
		var result struct {
			Live, Archive                                   checkpoint
			FirstDelivery, FirstMessagePacket, ReaderEpochs json.RawMessage
		}
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatal(err)
		}
		if result.Live.Generation != uint64(step) {
			t.Fatalf("wrong live head after step %d: %+v", step, result.Live)
		}
		if step == 1 {
			first = result.Live
			firstDelivery, firstMessagePacket, readerEpochs = result.FirstDelivery, result.FirstMessagePacket, result.ReaderEpochs
		} else if result.Archive.Generation != uint64(step-1) || result.Archive.Through != uint64(step) {
			t.Fatalf("archive did not cover intervening live generations: %+v", result.Archive)
		}
	}
	// Use a fresh listener to exercise moderation independently of the
	// archive scenario's per-address request bucket.
	moderationRoom := httptest.NewTLSServer(runtime.handler())
	defer moderationRoom.Close()
	httpCall := func(method, path string, status int) *http.Response {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, method, moderationRoom.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+readerSession["token"])
		response, err := moderationRoom.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status {
			response.Body.Close()
			t.Fatalf("%s %s status = %d, expected %d", method, path, response.StatusCode, status)
		}
		return response
	}
	readWindow := func(path string, first uint64) access.HistoryWindow {
		t.Helper()
		response := httpCall(http.MethodGet, "/api/v3/history/window/"+path, http.StatusOK)
		defer response.Body.Close()
		var body access.HistoryWindow
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.First != first || body.Removed == nil {
			t.Fatalf("history window = %+v, %v, expected first %d", body, err, first)
		}
		return body
	}
	readWindow(channel, 1)
	target := "/api/v3/history/message/" + channel
	httpCall(http.MethodDelete, target+"/3", http.StatusForbidden).Body.Close()
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.delete-other"}}
	commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 5),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	initialWindow := readWindow(channel, 3)
	if !initialWindow.CanDeleteOther {
		t.Fatal("read-only moderator did not receive deletion capability")
	}
	httpCall(http.MethodGet, "/api/v3/history/window/"+strings.Repeat("e", 32), http.StatusForbidden).Body.Close()
	httpCall(http.MethodDelete, target+"/1", http.StatusForbidden).Body.Close()
	if err := store.DeleteMessage(ctx, runtime.resolveSession(ownerSession["token"]), nil, channel, 1); err != nil {
		t.Fatalf("owner deletion outside the reader's history: %v", err)
	}
	httpCall(http.MethodDelete, target+"/3", http.StatusOK).Body.Close()
	httpCall(http.MethodDelete, target+"/3", http.StatusOK).Body.Close()
	window := readWindow(channel+"?after="+initialWindow.Cursor, 3)
	if len(window.Removed) != 1 || window.Removed[0] != 3 || window.Cursor == "" {
		t.Fatalf("deletion delta = %+v", window)
	}
	if next := readWindow(channel+"?after="+window.Cursor, 3); len(next.Removed) != 0 || next.Cursor != window.Cursor {
		t.Fatalf("deletion retry created a duplicate event: %+v", next)
	}
	response := httpCall(http.MethodGet, "/api/v3/history/live/"+channel, http.StatusOK)
	defer response.Body.Close()
	var page access.LiveMessagePage
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil || len(page.Messages) != 2 ||
		page.Messages[0].Position != 4 || page.Messages[1].Position != 5 {
		t.Fatalf("live history after deletion: %+v, %v", page, err)
	}
}
