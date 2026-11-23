package main

import (
	"bytes"
	"context"
	"encoding/json"
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

func TestProtectedVoiceHTTPClient(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	store := testMembershipStore(t)
	source, destination := strings.Repeat("a", 32), strings.Repeat("b", 32)
	_, _, owner, reader := protectedTestStateWith(t, store, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.speak"}}
		state.Channels[source] = access.Channel{Kind: "voice", NextPosition: 1}
		state.Channels[destination] = access.Channel{Kind: "voice", NextPosition: 1, ACL: access.ACL{
			Roles: map[string]access.Overwrite{"reader": {Deny: []string{"voice.speak"}}},
		}}
	})
	draft, err := store.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, store, owner, 1, draft)); err != nil {
		t.Fatal(err)
	}
	var removeAttempts atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var target struct{ Identity string }
		if err := json.NewDecoder(r.Body).Decode(&target); err != nil || target.Identity != reader.Access.SessionID {
			http.Error(w, "wrong fixture participant", http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/GetParticipant":
			respond(w, http.StatusOK, map[string]string{"identity": target.Identity, "state": "ACTIVE"})
		case "/twirp/livekit.RoomService/RemoveParticipant":
			if removeAttempts.Add(1)%2 != 0 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer media.Close()
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64), PresenceURL: media.URL}
	handler := newProtectedVoiceHandler(store, cfg)
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mediaURLKey{}, "ws://"+r.Host+"/rtc")))
	}))
	defer httpServer.Close()
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		store.runProtectedVoiceControl(workerCtx, cfg, 20*time.Millisecond, nil)
	}()
	defer func() { stopWorker(); <-workerDone }()

	var serverID string
	if err := store.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]string{"base": httpServer.URL, "serverId": serverID, "source": source, "destination": destination,
		"readerToken": reader.Token, "ownerToken": owner.Token, "profileId": reader.Access.EffectiveProfileID})
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-voice-http-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, script)
	hideWindow(command)
	command.Stdin = bytes.NewReader(input)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Client protected voice HTTP integration: %v\n%s", err, output)
	}
	if removeAttempts.Load() != 4 {
		t.Fatalf("expected one failed removal and one acknowledged retry each for move and leave, got %d", removeAttempts.Load())
	}
}
