package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"testing"
)

func testMembershipStore(t *testing.T) *membershipStore {
	t.Helper()
	s, err := openMembershipStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.db.Close() })
	return s
}

func insertTestIdentity(t *testing.T, s *membershipStore, seed byte) (string, string) {
	t.Helper()
	identity := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32)).Public().(ed25519.PublicKey)
	device := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed + 100}, 32)).Public().(ed25519.PublicKey)
	pHash, dHash := sha256.Sum256(identity), sha256.Sum256(device)
	p, d := hex.EncodeToString(pHash[:]), hex.EncodeToString(dHash[:])
	if _, err := s.db.Exec("INSERT INTO profiles(profile_id,identity_public_key,nickname,created_at) VALUES(?,?,'Test',1)", p, []byte(identity)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("INSERT INTO devices(device_id,original_profile_id,signing_public_key,label,identity_certificate,created_at) VALUES(?,?,?,'Test device',?,1)", d, p, []byte(device), make([]byte, 64)); err != nil {
		t.Fatal(err)
	}
	return p, d
}

func TestMembershipSchemaFreshAndPersistent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "room.sqlite")
	s, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	if err = s.db.QueryRow("SELECT server_id FROM server_state").Scan(&id); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.db.QueryRow("SELECT COUNT(*) FROM channels WHERE protected_kind IS NOT NULL").Scan(&count); err != nil || count != 2 {
		t.Fatalf("default channels: %d %v", count, err)
	}
	s.db.Close()
	s, err = openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	var again string
	if err = s.db.QueryRow("SELECT server_id FROM server_state").Scan(&again); err != nil || again != id {
		t.Fatalf("identity changed on restart: %v", err)
	}
}

func TestMembershipSchemaRejectsLegacyWithoutDestroyingData(t *testing.T) {
	s := testMembershipStore(t)
	if _, err := s.db.Exec("PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	if err := s.initialize(); err == nil {
		t.Fatal("legacy schema accepted")
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM channels").Scan(&count); err != nil || count != 2 {
		t.Fatalf("legacy database altered: %d %v", count, err)
	}
}

func TestMembershipSchemaProtectsDefaultChannels(t *testing.T) {
	s := testMembershipStore(t)
	for _, query := range []string{
		"DELETE FROM channels WHERE protected_kind='default_text'",
		"UPDATE channels SET protected_kind=NULL WHERE protected_kind='default_voice'",
		"UPDATE channels SET kind='voice' WHERE protected_kind='default_text'",
		"UPDATE channels SET channel_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE protected_kind='default_text'",
	} {
		if _, err := s.db.Exec(query); err == nil {
			t.Errorf("protected channel modification accepted: %s", query)
		}
	}
	if _, err := s.db.Exec("UPDATE channels SET name='Renamed' WHERE protected_kind='default_text'"); err != nil {
		t.Fatal("rename must preserve identity", err)
	}
}

func TestMembershipSchemaBindingsCannotChainOrCycle(t *testing.T) {
	s := testMembershipStore(t)
	a, _ := insertTestIdentity(t, s, 1)
	b, _ := insertTestIdentity(t, s, 2)
	c, _ := insertTestIdentity(t, s, 3)
	if _, err := s.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,1)", b, a); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{a, b}, {a, c}, {c, b}, {b, b}} {
		if _, err := s.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,1)", pair[0], pair[1]); err == nil {
			t.Fatalf("invalid binding accepted: %v", pair)
		}
	}
	if _, err := s.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,1)", c, a); err != nil {
		t.Fatal("three-device group rejected", err)
	}
	if _, err := s.db.Exec("DELETE FROM profile_bindings WHERE source_profile_id=?", b); err != nil {
		t.Fatal(err)
	}
	var remaining string
	if err := s.db.QueryRow("SELECT target_profile_id FROM profile_bindings WHERE source_profile_id=?", c).Scan(&remaining); err != nil || remaining != a {
		t.Fatal("unbinding changed another device", err)
	}
}

func TestMembershipSchemaMessageProvenanceAndAttachmentOwnership(t *testing.T) {
	s := testMembershipStore(t)
	a, ad := insertTestIdentity(t, s, 1)
	b, bd := insertTestIdentity(t, s, 2)
	var channel, voice string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_text'").Scan(&channel)
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_voice'").Scan(&voice)
	insert := func(p, d, c string) error {
		_, err := s.db.Exec("INSERT INTO messages(channel_id,author_profile_id,author_device_id,request_id,sent_at,crypto_context_id,nonce,ciphertext) VALUES(?,?,?,'request',1,?,?,?)", c, p, d, string(bytes.Repeat([]byte{'a'}, 64)), make([]byte, 12), make([]byte, 17))
		return err
	}
	if err := insert(a, bd, channel); err == nil {
		t.Fatal("forged original author accepted")
	}
	if err := insert(a, ad, voice); err == nil {
		t.Fatal("voice channel accepted message")
	}
	if err := insert(a, ad, channel); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE messages SET author_profile_id=?,author_device_id=?", b, bd); err == nil {
		t.Fatal("original author rewritten")
	}
	if _, err := s.db.Exec("DELETE FROM profiles WHERE profile_id=?", a); err == nil {
		t.Fatal("author deleted while referenced")
	}
	if _, err := s.db.Exec("INSERT INTO attachments(attachment_id,channel_id,owner_device_id,crypto_context_id,nonce,ciphertext,created_at) VALUES(?,?,?,?,?,?,1)", string(bytes.Repeat([]byte{'a'}, 32)), channel, bd, string(bytes.Repeat([]byte{'a'}, 64)), make([]byte, 12), make([]byte, 17)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE attachments SET message_id=1"); err == nil {
		t.Fatal("attachment attached to another author's message")
	}
}

func TestMembershipSchemaRejectsParallelSingleUseReservations(t *testing.T) {
	s := testMembershipStore(t)
	a, ad := insertTestIdentity(t, s, 1)
	b, bd := insertTestIdentity(t, s, 2)
	for _, kind := range []string{"single", "reusable"} {
		id := string(bytes.Repeat([]byte{kind[0]}, 32))
		var max any = 1
		if kind == "reusable" {
			max = nil
		}
		hash := sha256.Sum256([]byte(kind))
		if _, err := s.db.Exec("INSERT INTO invites(invite_id,token_hash,kind,created_at,expires_at,max_uses) VALUES(?,?,?,1,100,?)", id, hash[:], kind, max); err != nil {
			t.Fatal(err)
		}
		_, err := s.db.Exec("INSERT INTO invite_attempts(attempt_id,invite_id,invite_kind,profile_id,device_id,request_id,state,reserved_at,deadline) VALUES(?,?,?,?,?,?,'reserved',2,90)", kind+"1", id, kind, a, ad, kind)
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.db.Exec("INSERT INTO invite_attempts(attempt_id,invite_id,invite_kind,profile_id,device_id,request_id,state,reserved_at,deadline) VALUES(?,?,?,?,?,?,'reserved',2,90)", kind+"2", id, kind, b, bd, kind)
		if kind == "single" && err == nil {
			t.Fatal("single-use invite reserved twice")
		}
		if kind == "reusable" && err != nil {
			t.Fatal("independent reusable reservations blocked", err)
		}
	}
}
