package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedScopedRevisionGroupedAudience(t *testing.T) {
	for _, version := range []int{access.TextGroupedArchiveRotationProjectionVersion, access.TextGroupedRevisionAudienceProjectionVersion} {
		t.Run(fmt.Sprintf("projection_v%d", version), func(t *testing.T) { testProtectedScopedRevisionGroupedAudience(t, version) })
	}
}

func testProtectedScopedRevisionGroupedAudience(t *testing.T, version int) {
	ctx := context.Background()
	server := testMembershipStore(t)
	channel := strings.Repeat("a", 32)
	lateProfile := strings.Repeat("e", 64)
	deviceID := func(seed byte) string {
		digest := sha256.Sum256(newTestMemberSigner(seed).device.Public().(ed25519.PublicKey))
		return hex.EncodeToString(digest[:])
	}
	secondReaderDevice, lateDevice := deviceID(3), deviceID(4)
	var readerProfile string
	_, initial, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
		state.Channels[channel] = state.Channels["private"]
		delete(state.Channels, "private")
		for id := range state.Members {
			if id != state.Owner {
				readerProfile = id
			}
		}
		state.Members[lateProfile] = access.Subject{ID: lateProfile, Active: true}
		for _, item := range []struct {
			profile string
			device  string
			seed    byte
		}{{readerProfile, secondReaderDevice, 3}, {lateProfile, lateDevice, 4}} {
			state.PolicyDevices[item.device] = access.PolicyDevice{ProfileID: item.profile, PublicKey: testSigningKey(item.seed)}
			state.KeyRecipients[item.device] = access.KeyRecipient{ProfileID: item.profile, Kind: "device", PublicKey: testRecipientKey(t, item.seed)}
		}
	})
	commitPolicy := func(request access.PolicyDraft) access.PolicyProof {
		t.Helper()
		draft, err := server.previewProtectedPolicy(ctx, owner.Token, request)
		if err != nil {
			t.Fatal(err)
		}
		result, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, draft))
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	anchor := commitPolicy(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
		TextProjectionVersion: version, TextProjectionSeed: strings.Repeat("a", 64)})
	appendOriginal := func(key, operation string) uint64 {
		t.Helper()
		attempt := access.MessageAttempt{ChannelID: channel, KeyID: key, OperationID: operation, Nonce: make([]byte, 12), Ciphertext: make([]byte, 17)}
		receipt, err := server.appendProtectedMessage(ctx, owner.Token, signProtectedTestMessage(t, server, owner, 1, attempt))
		if err != nil {
			t.Fatal(err)
		}
		return receipt.Position
	}
	live, packages := prepareTestEpoch(t, server, owner, 1, channel, strings.Repeat("b", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, live, packages); err != nil {
		t.Fatal(err)
	}
	beforeLate := appendOriginal(live.KeyID, strings.Repeat("3", 32))
	commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order, Assignments: map[string][]string{lateProfile: {"reader"}}}})
	nextLive, nextPackages := prepareTestEpoch(t, server, owner, 1, channel, strings.Repeat("c", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, nextLive, nextPackages); err != nil {
		t.Fatal(err)
	}
	afterLate := appendOriginal(nextLive.KeyID, strings.Repeat("4", 32))
	archive, archivePackages := prepareTestEpochForPurpose(t, server, owner, 1, channel, strings.Repeat("d", 64), access.ArchiveEpoch)
	var links []access.ArchiveLink
	for _, record := range []access.EpochRecord{live, nextLive} {
		links = append(links, access.ArchiveLink{ArchiveTarget: access.ArchiveTarget{Purpose: record.Purpose, Generation: record.Generation, KeyID: record.KeyID},
			Ciphertext: make([]byte, access.ArchiveLinkSize)})
	}
	var err error
	archive.ArchiveLinksDigest, err = access.ArchiveLinksDigest(links)
	if err != nil {
		t.Fatal(err)
	}
	archive.ArchiveWrapKey = testRecipientKey(t, 9)
	if err := server.commitProtectedEpoch(ctx, owner.Token, signTestEpoch(t, server, owner, 1, archive), archivePackages, links...); err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("e", 64)
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("f", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	login := func(member memberSession, seed byte) string {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest,
			server.protectedBinding, challenge.Nonce, member.Access.DeviceID)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: member.Access.DeviceID, Nonce: challenge.Nonce,
			Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session.Token
	}
	writerToken, readerToken := login(owner, 1), login(reader, 2)
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	read := func(token string, position uint64, scoped bool, wantStatus int) access.RevisionBasis {
		t.Helper()
		url := fmt.Sprintf("%s/api/v3/history/revision/%s/%d/basis", room.URL, channel, position)
		if scoped {
			url += "?scoped=1"
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := room.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != wantStatus {
			var details json.RawMessage
			_ = json.NewDecoder(response.Body).Decode(&details)
			t.Fatalf("basis at position %d: HTTP %d, expected %d: %s", position, response.StatusCode, wantStatus, details)
		}
		var basis access.RevisionBasis
		if err := json.NewDecoder(response.Body).Decode(&basis); err != nil {
			t.Fatal(err)
		}
		return basis
	}
	if denied := read(readerToken, beforeLate, true, http.StatusForbidden); denied.GroupedAudience != nil || len(denied.Recipients) != 0 {
		t.Fatal("non-author obtained the revision audience")
	}
	if unscoped := read(writerToken, beforeLate, false, http.StatusOK); unscoped.GroupedAudience != nil || unscoped.AuthorPolicy != nil {
		t.Fatal("unscoped path returned scoped audience data")
	}
	old := read(writerToken, beforeLate, true, http.StatusOK)
	latest := read(writerToken, afterLate, true, http.StatusOK)
	if old.AuthorPolicy == nil || latest.AuthorPolicy == nil || len(old.Recipients) != 2 || len(latest.Recipients) != 3 {
		t.Fatalf("wrong original-position intersection: %v %v", old.Recipients, latest.Recipients)
	}
	if version < access.TextGroupedRevisionAudienceProjectionVersion {
		if old.GroupedAudience != nil || latest.GroupedAudience != nil || old.AuthorPolicy.GroupedAudienceProof != nil || latest.AuthorPolicy.GroupedAudienceProof != nil ||
			old.AuthorPolicy.AudienceProof == nil || latest.AuthorPolicy.AudienceProof == nil {
			t.Fatal("v14 revision proof contract changed")
		}
		return
	}
	for _, expected := range []struct {
		basis    access.RevisionBasis
		profiles map[string]string
		groups   int
	}{
		{old, map[string]string{reader.Access.DeviceID: readerProfile, secondReaderDevice: readerProfile}, 1},
		{latest, map[string]string{reader.Access.DeviceID: readerProfile, secondReaderDevice: readerProfile, lateDevice: lateProfile}, 2},
	} {
		grouped, proof := expected.basis.GroupedAudience, expected.basis.AuthorPolicy.GroupedAudienceProof
		if grouped == nil || proof == nil || len(proof.Siblings) != 53 || !reflect.DeepEqual(grouped.Profiles, expected.profiles) || len(grouped.Openings) != expected.groups {
			t.Fatalf("wrong grouped audience at position %d: %+v", expected.basis.Position, grouped)
		}
		for _, profile := range expected.profiles {
			opening := grouped.Openings[profile]
			if !validHexID(opening.Salt, 64) || !validHexID(opening.ContentSalt, 64) || opening.Salt == opening.ContentSalt {
				t.Fatalf("invalid opening at position %d for %s", expected.basis.Position, profile)
			}
		}
	}
	if old.GroupedAudience.Openings[readerProfile] != latest.GroupedAudience.Openings[readerProfile] {
		t.Fatal("same current policy and reader profile yielded different group openings")
	}
}
