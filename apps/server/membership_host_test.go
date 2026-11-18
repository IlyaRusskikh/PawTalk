package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMembershipHostStatusIsReadOnlyAndDoesNotExportCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	if _, err := inspectMembershipHost(path); err == nil {
		t.Fatal("missing status accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("read-only status created a database", err)
	}
	store, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	initial, err := inspectMembershipHost(path)
	if err != nil || initial["initialized"] != false {
		t.Fatal(initial, err)
	}
	bootstrapTestServer(t, store, newTestMemberSigner(1))
	ready, err := inspectMembershipHost(path)
	if err != nil || ready["initialized"] != true || ready["serverId"] != initial["serverId"] || len(ready) != 4 {
		t.Fatal("host status shape/identity", ready, err)
	}
	raw, _ := json.Marshal(ready)
	var public map[string]any
	if json.Unmarshal(raw, &public) != nil || public["apiProtocolVersion"] != float64(2) || public["dataSchema"] != float64(2) {
		t.Fatal("invalid host status")
	}
}
