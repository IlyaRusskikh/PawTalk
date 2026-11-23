package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hpke"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedHPKEPackageDelivery(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	server := testMembershipStore(t)
	store, state, owner, reader := protectedTestState(t, server)
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order, nil); err != nil {
		t.Fatal(err)
	}
	task, err := server.claimProtectedRotation(ctx, owner.Token, "private", access.LiveEpoch)
	if err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	record := task.EpochRecord
	record.KeyID = strings.Repeat("a", 64)
	packageInfo := func(id, key, purpose string) []byte {
		t.Helper()
		info, err := signatureFrame("pawtalk-epoch-package-v1", serverID, record.ChannelID, strconv.FormatUint(record.Generation, 10),
			strconv.FormatInt(record.Revision, 10), record.PolicyDigest, record.PreviousDigest, record.TaskID,
			record.LeaseID, record.KeyID, id, key, purpose)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}
	secret := bytes.Repeat([]byte{0x51}, 32)
	var packages []access.EpochPackage
	for id, recipient := range task.Recipients {
		raw, _ := hex.DecodeString(recipient.PublicKey)
		public, err := ecdh.X25519().NewPublicKey(raw)
		if err != nil {
			t.Fatal(err)
		}
		key, err := hpke.NewDHKEMPublicKey(public)
		if err != nil {
			t.Fatal(err)
		}
		info := packageInfo(id, recipient.PublicKey, record.Purpose)
		enc, sender, err := hpke.NewSender(key, hpke.HKDFSHA256(), hpke.AES128GCM(), info)
		if err != nil {
			t.Fatal(err)
		}
		ciphertext, err := sender.Seal(info, secret)
		if err != nil {
			t.Fatal(err)
		}
		packages = append(packages, access.EpochPackage{RecipientID: id, Purpose: record.Purpose, Ciphertext: append(enc, ciphertext...)})
	}
	record.PackagesDigest, err = access.PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	record = signTestEpoch(t, server, owner, 1, record)
	if err := server.commitProtectedEpoch(ctx, owner.Token, record, packages); err != nil {
		t.Fatal(err)
	}
	if _, err := server.loadProtectedEpochPackage(ctx, reader.Token, record.ChannelID, record.KeyID, "archive"); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("limited reader archive request: %v", err)
	}
	delivery, err := server.loadProtectedEpochPackage(ctx, reader.Token, record.ChannelID, record.KeyID, "live")
	if err != nil || delivery.Package.RecipientID != reader.Access.DeviceID || delivery.Proof.Count != 2 {
		t.Fatalf("reader's package unavailable: %+v, %v", delivery.Proof, err)
	}
	receiver := task.Recipients[reader.Access.DeviceID]
	privateRaw := bytes.Repeat([]byte{22}, 32)
	payload, err := json.Marshal(map[string]any{
		"delivery": delivery, "secret": hex.EncodeToString(secret), "testPrivateKey": hex.EncodeToString(privateRaw),
		"context": map[string]any{
			"serverId": serverID, "channelId": record.ChannelID, "generation": record.Generation, "revision": record.Revision,
			"policyDigest": record.PolicyDigest, "previousDigest": record.PreviousDigest, "taskId": record.TaskID,
			"leaseId": record.LeaseID, "keyId": record.KeyID, "recipientId": reader.Access.DeviceID,
			"recipientKey": receiver.PublicKey, "purpose": "live",
		},
		"signer": map[string]string{
			"key":       hex.EncodeToString(newTestMemberSigner(1).device.Public().(ed25519.PublicKey)),
			"profileId": owner.Access.EffectiveProfileID, "deviceId": owner.Access.DeviceID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-package-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, node, script)
	hideWindow(cmd)
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("HPKE client integration: %v\n%s", err, output)
	}
	ciphertext, err := base64.StdEncoding.Strict().DecodeString(string(output))
	if err != nil || len(ciphertext) != access.EpochPackageSize {
		t.Fatalf("invalid client ciphertext: %v", err)
	}
	private, err := ecdh.X25519().NewPrivateKey(privateRaw)
	if err != nil {
		t.Fatal(err)
	}
	key, err := hpke.NewDHKEMPrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	info := packageInfo(reader.Access.DeviceID, receiver.PublicKey, "live")
	opener, err := hpke.NewRecipient(ciphertext[:32], key, hpke.HKDFSHA256(), hpke.AES128GCM(), info)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := opener.Open(info, ciphertext[32:])
	if err != nil || !bytes.Equal(secret, recovered) {
		t.Fatalf("Go could not authenticate Node ciphertext: %v", err)
	}
	if _, err := store.ApplyRoles(ctx, record.Revision, owner.Access.EffectiveProfileID, state.Roles, state.Order,
		map[string][]string{reader.Access.EffectiveProfileID: nil}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.loadProtectedEpochPackage(ctx, reader.Token, record.ChannelID, record.KeyID, "live"); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("revoked reader fetched its previously issued package: %v", err)
	}
}
