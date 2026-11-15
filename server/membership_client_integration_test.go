package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestMembershipMainProcessClientIntegration(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed; run this main-process integration on the Client verification host")
	}
	s := testMembershipStore(t)
	bootstrap, err := s.createBootstrap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newMembershipHandler(s, config{}))
	defer server.Close()
	input, _ := json.Marshal(map[string]any{"base": server.URL, "serverId": bootstrap.ServerID, "inviteId": bootstrap.InviteID, "token": bootstrap.Token})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	script, err := filepath.Abs("../scripts/membership-client-integration.mjs")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, script)
	hideWindow(command)
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("main-process HTTP integration failed: %v\n%s", err, output)
	}
	t.Log(string(output))
}
