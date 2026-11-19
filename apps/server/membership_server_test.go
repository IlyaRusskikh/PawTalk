package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestServerRenameAuthorizationConcurrencyAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	s, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.db.Close() })
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	ctx := context.Background()
	before, err := s.state(ctx, admin.Token)
	if err != nil {
		t.Fatal(err)
	}
	handler := newMembershipHandler(s, config{})
	patch := func(token, name, expected, rid string) int {
		body, _ := json.Marshal(map[string]string{"name": name, "expectedName": expected, "requestId": rid})
		req := httptest.NewRequest("PATCH", "/api/v2/server", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w.Code
	}
	for i, role := range []string{"member", "moderator"} {
		key := newTestMemberSigner(byte(i + 2))
		activateTestMember(t, s, key, role)
		if code := patch(loginTestMember(t, s, key).Token, "Forbidden", before.Name, strings.Repeat("1", 32)); code != 403 {
			t.Fatal(role, code)
		}
	}
	if code := patch("", "Forbidden", before.Name, strings.Repeat("2", 32)); code != 401 {
		t.Fatal("anonymous", code)
	}
	for _, bad := range []string{" ", "bad\nname", strings.Repeat("界", 65)} {
		if code := patch(admin.Token, bad, before.Name, strings.Repeat("3", 32)); code != 400 {
			t.Fatal("invalid name", code)
		}
	}
	if code := patch(admin.Token, "  Общее имя  ", before.Name, strings.Repeat("4", 32)); code != 200 {
		t.Fatal("rename", code)
	}
	if code := patch(admin.Token, "  Общее имя  ", before.Name, strings.Repeat("4", 32)); code != 200 {
		t.Fatal("retry", code)
	}
	if code := patch(admin.Token, "Changed payload", before.Name, strings.Repeat("4", 32)); code != 409 {
		t.Fatal("request reuse", code)
	}
	if code := patch(admin.Token, "Stale overwrite", before.Name, strings.Repeat("5", 32)); code != 409 {
		t.Fatal("stale form", code)
	}
	after, err := s.state(ctx, admin.Token)
	if err != nil || after.Name != "Общее имя" || after.ServerID != before.ServerID || after.Revision != before.Revision+1 {
		t.Fatal("shared state / stable identity", after, err)
	}
	s.db.Close()
	s, err = openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	after, err = s.state(ctx, admin.Token)
	if err != nil || after.Name != "Общее имя" {
		t.Fatal("name lost after reopen", err)
	}
}
