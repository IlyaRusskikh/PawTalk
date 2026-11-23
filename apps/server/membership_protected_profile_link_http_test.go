package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedProfileLinkHTTP(t *testing.T) {
	ctx := context.Background()
	store := testMembershipStore(t)
	primaryChannel, secondaryChannel := strings.Repeat("a", 32), strings.Repeat("b", 32)
	policy, initial, owner, primary := protectedTestStateWith(t, store, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
		state.Roles["writer"] = access.Role{Grants: []string{access.ChannelView, "invite.create"}}
		state.Order = []string{"reader", "writer"}
		delete(state.Channels, "private")
		state.Channels[primaryChannel] = access.Channel{Kind: "text", NextPosition: 1, ACL: access.ACL{
			Roles: map[string]access.Overwrite{"writer": {Deny: []string{access.ChannelView}}},
		}}
		state.Channels[secondaryChannel] = access.Channel{Kind: "text", NextPosition: 1, ACL: access.ACL{
			Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}},
		}}
	})
	anchorDraft, err := store.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := store.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, store, owner, 1, anchorDraft))
	if err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := store.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	store.protectedBinding = strings.Repeat("9", 64)
	runtime := &protectedRuntime{store: store, serverID: serverID, cutoverDigest: strings.Repeat("c", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	call := func(method, path, token string, input any, status int, code string, output any) {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, method, room.URL+"/api/v3"+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := room.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status || (code != "" && !bytes.Contains(raw, []byte(`"`+code+`"`))) {
			if path == "/session/open" && response.StatusCode < 300 {
				t.Fatalf("%s %s status %d, want %d %s", method, path, response.StatusCode, status, code)
			}
			t.Fatalf("%s %s status %d, want %d %s: %s", method, path, response.StatusCode, status, code, raw)
		}
		if output != nil {
			if err := json.Unmarshal(raw, output); err != nil {
				t.Fatal(err)
			}
		}
	}
	signFrame := func(key ed25519.PrivateKey, fields ...string) string {
		t.Helper()
		frame, err := signatureFrame(fields...)
		if err != nil {
			t.Fatal(err)
		}
		return b64.EncodeToString(ed25519.Sign(key, frame))
	}
	open := func(seed byte, status int, code string) protectedSessionReceipt {
		t.Helper()
		key := newTestMemberSigner(seed).device
		device := publicKeyID(key.Public().(ed25519.PublicKey))
		var challenge struct{ Nonce string }
		call(http.MethodGet, "/session/challenge", "", nil, http.StatusOK, "", &challenge)
		request := protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce,
			Signature: signFrame(key, "pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, store.protectedBinding, challenge.Nonce, device)}
		var session protectedSessionReceipt
		call(http.MethodPost, "/session/open", "", request, status, code, &session)
		return session
	}
	head := func() access.PolicyProof {
		t.Helper()
		proof, err := access.ReadPolicyHead(ctx, store.db, nil)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	issueInvite := func(session protectedSessionReceipt, issuerSeed, inviteSeed byte, id string) ed25519.PrivateKey {
		t.Helper()
		capability := newTestMemberSigner(inviteSeed).device
		uses := int64(1)
		input := access.InviteCreate{ID: id, TokenHash: publicKeyID(capability.Public().(ed25519.PublicKey)), PolicyDigest: head().Digest, MaxUses: &uses}
		frame, err := protectedInvitationFrame(serverID, access.Principal{ProfileID: session.ProfileID, DeviceID: session.DeviceID}, input, uses)
		if err != nil {
			t.Fatal(err)
		}
		input.Signature = ed25519.Sign(newTestMemberSigner(issuerSeed).device, frame)
		call(http.MethodPost, "/invites", session.Token, input, http.StatusOK, "", nil)
		return capability
	}
	redeem := func(key ed25519.PrivateKey, invite, operation string, deviceSeed, agreementSeed byte, status int, code string) access.InviteAdmission {
		t.Helper()
		identity := newTestMemberSigner(deviceSeed)
		claim := access.InviteRedeem{InviteID: invite, OperationID: operation, Nickname: "Synthetic profile link member",
			InvitePublicKey: b64.EncodeToString(key.Public().(ed25519.PublicKey)), ProfilePublicKey: b64.EncodeToString(identity.root.Public().(ed25519.PublicKey)),
			DevicePublicKey: b64.EncodeToString(identity.device.Public().(ed25519.PublicKey)), AgreementKey: testRecipientKey(t, agreementSeed)}
		frame, err := protectedInviteRedemptionFrame(serverID, runtime.cutoverDigest, claim)
		if err != nil {
			t.Fatal(err)
		}
		claim.InviteSignature = b64.EncodeToString(ed25519.Sign(key, frame))
		claim.ProfileSignature = b64.EncodeToString(ed25519.Sign(identity.root, frame))
		claim.DeviceSignature = b64.EncodeToString(ed25519.Sign(identity.device, frame))
		var receipt access.InviteAdmission
		call(http.MethodPost, "/invites/redeem", "", claim, status, code, &receipt)
		return receipt
	}
	ownerSession := open(1, http.StatusCreated, "")
	primarySession := open(2, http.StatusCreated, "")
	inviteID := strings.Repeat("2", 32)
	secondary := redeem(issueInvite(ownerSession, 1, 31, inviteID), inviteID, strings.Repeat("3", 32), 3, 23, http.StatusOK, "")
	roleDraft, err := policy.PreviewPolicy(ctx, runtime.resolveSession(ownerSession.Token), access.PolicyDraft{
		Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("4", 32), RoleUpdate: &access.RolePolicyUpdate{
			Roles: initial.Roles, Order: initial.Order, Assignments: map[string][]string{secondary.ProfileID: {"writer"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.commitProtectedPolicy(ctx, ownerSession.Token, signTestPolicyDraft(t, store, owner, 1, roleDraft)); err != nil {
		t.Fatal(err)
	}
	secondarySession := open(3, http.StatusCreated, "")
	assertDevices := func(session protectedSessionReceipt, expected ...string) {
		t.Helper()
		var result map[string]json.RawMessage
		call(http.MethodGet, "/devices/self", session.Token, nil, http.StatusOK, "", &result)
		var ids []string
		err := json.Unmarshal(result["deviceIds"], &ids)
		slices.Sort(expected)
		if err != nil || len(result) != 1 || !slices.Equal(ids, expected) {
			t.Fatalf("own devices response = %v, want IDs %v only (decode error %v)", result, expected, err)
		}
	}
	assertDevices(primarySession, primarySession.DeviceID)
	assertDevices(secondarySession, secondarySession.DeviceID)
	oldInvite := strings.Repeat("5", 32)
	oldCapability := issueInvite(secondarySession, 3, 32, oldInvite)
	assertChannel := func(session protectedSessionReceipt, expected string) {
		t.Helper()
		var projection access.Projection
		call(http.MethodGet, "/state", session.Token, nil, http.StatusOK, "", &projection)
		if len(projection.Channels) != 1 || projection.Channels[0].ID != expected {
			t.Fatalf("visible channels = %+v, want %s", projection.Channels, expected)
		}
	}
	assertChannel(primarySession, primaryChannel)
	assertChannel(secondarySession, secondaryChannel)
	deadline := store.now().Add(5 * time.Minute).UnixMilli()
	participant := func(session protectedSessionReceipt, seed byte) protectedProfileLinkPreviewRequest {
		return protectedProfileLinkPreviewRequest{ProfileID: session.ProfileID, DeviceID: session.DeviceID,
			PrimaryID: primarySession.ProfileID, ExpiresAt: deadline,
			Proof: signFrame(newTestMemberSigner(seed).device, "pawtalk-protected-profile-link-participant-v1", serverID,
				runtime.cutoverDigest, session.ProfileID, session.DeviceID, strconv.FormatInt(deadline, 10))}
	}
	call(http.MethodPost, "/profiles/link/preview", primarySession.Token, participant(ownerSession, 1), http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	call(http.MethodPost, "/profiles/link/preview", primarySession.Token, participant(secondarySession, 2), http.StatusForbidden, "INVALID_PROFILE_LINK_PROOF", nil)
	var preview access.ProfileLinkPreview
	call(http.MethodPost, "/profiles/link/preview", primarySession.Token, participant(secondarySession, 3), http.StatusOK, "", &preview)
	if preview.PrimaryProfileID != primary.Access.EffectiveProfileID || preview.SecondaryProfileID != secondary.ProfileID ||
		!slices.Equal(preview.PrimaryRoles, []string{"reader"}) || !slices.Equal(preview.SecondaryRoles, []string{"writer"}) || preview.MovedDevices != 1 {
		t.Fatalf("profile link preview = %+v", preview)
	}
	request := protectedProfileLinkApplyRequest{OperationID: strings.Repeat("6", 32), PolicyHead: preview.PolicyHead,
		PrimaryProfile: primarySession.ProfileID, PrimaryDevice: primarySession.DeviceID, SecondaryProfile: secondarySession.ProfileID,
		SecondaryDevice: secondarySession.DeviceID, ExpiresAt: deadline}
	frame := []string{"pawtalk-protected-profile-link-consent-v1", serverID, runtime.cutoverDigest, request.PolicyHead, request.OperationID,
		request.PrimaryProfile, request.PrimaryDevice, request.SecondaryProfile, request.SecondaryDevice, strconv.FormatInt(deadline, 10)}
	request.PrimaryProof = signFrame(newTestMemberSigner(2).device, frame...)
	request.SecondaryProof = signFrame(newTestMemberSigner(2).device, frame...)
	call(http.MethodPost, "/profiles/link/apply", primarySession.Token, request, http.StatusForbidden, "INVALID_PROFILE_LINK_PROOF", nil)
	assertChannel(secondarySession, secondaryChannel)
	request.SecondaryProof = signFrame(newTestMemberSigner(3).device, frame...)
	type linkReceipt struct {
		OperationID string `json:"operationId"`
		Revision    int64  `json:"revision"`
		Digest      string `json:"digest"`
	}
	var originalLink, repeatedLink linkReceipt
	call(http.MethodPost, "/profiles/link/apply", primarySession.Token, request, http.StatusOK, "", &originalLink)
	call(http.MethodPost, "/profiles/link/apply", primarySession.Token, request, http.StatusOK, "", &repeatedLink)
	if originalLink.OperationID != request.OperationID || originalLink.Revision != preview.PolicyRevision+1 || originalLink != repeatedLink {
		t.Fatal("exact profile-link retry did not return the original receipt")
	}
	assertChannel(primarySession, primaryChannel)
	call(http.MethodGet, "/state", secondarySession.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	linked := open(3, http.StatusCreated, "")
	if linked.ProfileID != primarySession.ProfileID || linked.DeviceID != secondarySession.DeviceID {
		t.Fatalf("reopened linked device profile=%s device=%s", linked.ProfileID, linked.DeviceID)
	}
	assertDevices(primarySession, primarySession.DeviceID, linked.DeviceID)
	assertDevices(linked, primarySession.DeviceID, linked.DeviceID)
	assertDevices(ownerSession, ownerSession.DeviceID)
	call(http.MethodGet, "/devices/self", secondarySession.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	assertChannel(linked, primaryChannel)
	call(http.MethodGet, "/invites", linked.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	admitted := redeem(oldCapability, oldInvite, strings.Repeat("7", 32), 4, 24, http.StatusOK, "")
	state, _, err := policy.Snapshot(ctx)
	if err != nil || !state.Members[admitted.ProfileID].Active || len(state.Members[admitted.ProfileID].Roles) != 0 || state.Owner != ownerSession.ProfileID {
		t.Fatalf("previously signed invite failed to admit baseline member: %v", err)
	}
	var issuer string
	if err := store.db.QueryRow("SELECT creator_profile_id FROM protected_invites WHERE id=?", oldInvite).Scan(&issuer); err != nil || issuer != secondarySession.ProfileID {
		t.Fatalf("old invite issuer changed: %v", err)
	}
	unlink := protectedProfileUnlinkApplyRequest{OperationID: strings.Repeat("8", 32), PolicyHead: head().Digest, Source: secondarySession.ProfileID, ExpiresAt: deadline}
	unlinkFrame := []string{"pawtalk-protected-profile-unlink-consent-v1", serverID, runtime.cutoverDigest,
		unlink.PolicyHead, unlink.OperationID, primarySession.ProfileID, primarySession.DeviceID, unlink.Source, strconv.FormatInt(deadline, 10)}
	unlink.Proof = signFrame(newTestMemberSigner(3).device, unlinkFrame...)
	call(http.MethodPost, "/profiles/unlink/apply", primarySession.Token, unlink, http.StatusForbidden, "INVALID_PROFILE_LINK_PROOF", nil)
	assertChannel(linked, primaryChannel)
	unlink.Proof = signFrame(newTestMemberSigner(2).device, unlinkFrame...)
	call(http.MethodPost, "/profiles/unlink/apply", primarySession.Token, unlink, http.StatusOK, "", nil)
	call(http.MethodGet, "/devices/self", linked.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	assertDevices(primarySession, primarySession.DeviceID)
	call(http.MethodGet, "/state", linked.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	open(3, http.StatusForbidden, "PROTECTED_PROFILE_UNLINKED")
	assertChannel(primarySession, primaryChannel)
	state, _, err = policy.Snapshot(ctx)
	if err != nil || state.Members[secondary.ProfileID].Active || len(state.Members[secondary.ProfileID].Roles) != 0 ||
		!state.PolicyDevices[secondary.DeviceID].Revoked || state.ProfileBindings[secondary.ProfileID] != "" || state.Owner != ownerSession.ProfileID {
		t.Fatalf("unlink restored prior membership or changed ownership: %v", err)
	}
	freshInvite := strings.Repeat("a", 32)
	fresh := redeem(issueInvite(ownerSession, 1, 33, freshInvite), freshInvite, strings.Repeat("b", 32), 3, 42, http.StatusOK, "")
	newSession := open(3, http.StatusCreated, "")
	state, _, err = policy.Snapshot(ctx)
	if err != nil || fresh.ProfileID != secondary.ProfileID || newSession.ProfileID != secondary.ProfileID ||
		len(state.Members[secondary.ProfileID].Roles) != 0 || state.KeyRecipients[secondary.DeviceID].PublicKey != testRecipientKey(t, 42) {
		t.Fatalf("detached profile did not readmit with fresh recipient and baseline rights: %v", err)
	}

	request.OperationID, request.PolicyHead = strings.Repeat("c", 32), head().Digest
	frame = []string{"pawtalk-protected-profile-link-consent-v1", serverID, runtime.cutoverDigest, request.PolicyHead, request.OperationID,
		request.PrimaryProfile, request.PrimaryDevice, request.SecondaryProfile, request.SecondaryDevice, strconv.FormatInt(deadline, 10)}
	request.PrimaryProof = signFrame(newTestMemberSigner(2).device, frame...)
	request.SecondaryProof = signFrame(newTestMemberSigner(3).device, frame...)
	call(http.MethodPost, "/profiles/link/apply", primarySession.Token, request, http.StatusOK, "", nil)
	linked = open(3, http.StatusCreated, "")
	assertChannel(linked, primaryChannel)

	ban := protectedDepartureIntent{ProfileID: ownerSession.ProfileID, DeviceID: ownerSession.DeviceID, Target: primarySession.ProfileID,
		OperationID: strings.Repeat("d", 32), PolicyHead: head().Digest, Reason: "Synthetic linked-profile ban",
		ExpiresAt: store.now().Add(time.Hour).UnixMilli()}
	ban.Signature = signFrame(newTestMemberSigner(1).device, "pawtalk-protected-member-moderation-v1", serverID, runtime.cutoverDigest,
		ban.ProfileID, ban.DeviceID, ban.OperationID, ban.PolicyHead, access.BanPolicyMember, ban.Target, ban.Reason, strconv.FormatInt(ban.ExpiresAt, 10))
	call(http.MethodPost, "/moderation/member/ban", ownerSession.Token, ban, http.StatusOK, "", nil)
	for _, session := range []protectedSessionReceipt{primarySession, linked} {
		call(http.MethodGet, "/state", session.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	}
	open(2, http.StatusForbidden, "BANNED")
	open(3, http.StatusForbidden, "BANNED")

	rejoinInvite := strings.Repeat("e", 32)
	rejoinKey := issueInvite(ownerSession, 1, 34, rejoinInvite)
	redeem(rejoinKey, rejoinInvite, strings.Repeat("f", 32), 3, 43, http.StatusForbidden, "BANNED")
	unrelated := redeem(rejoinKey, rejoinInvite, strings.Repeat("0", 32), 5, 45, http.StatusOK, "")
	unrelatedSession := open(5, http.StatusCreated, "")
	if unrelated.ProfileID != unrelatedSession.ProfileID || unrelated.ProfileID == primarySession.ProfileID {
		t.Fatal("independent identity did not receive an independent membership")
	}
	blockedLink := participant(primarySession, 2)
	blockedLink.PrimaryID = unrelatedSession.ProfileID
	call(http.MethodPost, "/profiles/link/preview", unrelatedSession.Token, blockedLink, http.StatusForbidden, "BANNED", nil)
}
