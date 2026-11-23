package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedSelfhostPinnedTLS(t *testing.T) {
	ctx := context.Background()
	store := testMembershipStore(t)
	var offset atomic.Int64
	now := store.now
	store.now = func() time.Time { return now().Add(time.Duration(offset.Load()) * time.Millisecond) }
	certificate, fingerprint, err := roomCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	keys := newTestMemberSigner(1)
	owner := protectedSelfhostOwner{
		ProfileKey:   hex.EncodeToString(keys.root.Public().(ed25519.PublicKey)),
		DeviceKey:    hex.EncodeToString(keys.device.Public().(ed25519.PublicKey)),
		AgreementKey: testRecipientKey(t, 13), Nickname: "Local owner", DeviceLabel: "Desktop",
	}
	pending, err := prepareProtectedSelfhost(ctx, store, fingerprint, owner)
	if err != nil {
		t.Fatal(err)
	}
	approved := signProtectedSelfhostFixture(t, pending.offer, fingerprint, owner.AgreementKey, keys)
	invalid := approved
	invalid.ProfileSignature = approved.PolicySignature
	if runtime, _, err := pending.activate(ctx, store, invalid); runtime != nil || !errors.Is(err, errInvalidProtectedSelfhostApproval) {
		t.Fatalf("forged profile approval activated: %v", err)
	}
	invalid = approved
	invalid.PolicySignature = approved.ProfileSignature
	if runtime, _, err := pending.activate(ctx, store, invalid); runtime != nil || err == nil {
		t.Fatalf("forged policy approval activated: %v", err)
	}
	invalid = approved
	invalid.ScopeAttestation = approved.ProfileSignature
	if runtime, _, err := pending.activate(ctx, store, invalid); runtime != nil || err == nil {
		t.Fatalf("forged scope attestation activated: %v", err)
	}
	var count int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM profiles").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed bootstrap left an owner: %d, %v", count, err)
	}
	runtime, ready, err := pending.activate(ctx, store, approved)
	if err != nil {
		t.Fatal(err)
	}
	policySignature, _ := decodeFixed(approved.PolicySignature, ed25519.SignatureSize)
	if ready.AnchorDigest != publicKeyID(policySignature) {
		t.Fatalf("incorrect signed anchor: %+v", ready)
	}
	media := httptest.NewServer(http.NotFoundHandler())
	defer media.Close()
	target, err := url.Parse(media.URL)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{APIKey: "test", APISecret: strings.Repeat("e", 64), PresenceURL: media.URL}
	server := httptest.NewUnstartedServer(runtime.handlerWithVoice(cfg, target))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	defer server.Close()
	client := selfhostPinnedClient(certificate.Leaf, fingerprint)
	defer client.CloseIdleConnections()
	wrong := selfhostPinnedClient(certificate.Leaf, strings.Repeat("0", 64))
	defer wrong.CloseIdleConnections()
	if response, err := wrong.Get(server.URL + "/api/config"); err == nil {
		response.Body.Close()
		t.Fatal("wrong TLS pin was accepted")
	}
	request := func(method, path, token string, input any, status int, output any) {
		t.Helper()
		selfhostFixtureRequest(t, client, server.URL, method, path, token, input, status, output)
	}
	discovery := protectedRuntimeConfig{}
	request(http.MethodGet, "/api/config", "", nil, http.StatusOK, &discovery)
	if discovery.Protocol != 3 || discovery.Schema != protectedDataSchemaVersion || !discovery.E2EERequired || !discovery.Voice || !discovery.Presence ||
		discovery.ServerID != ready.ServerID || discovery.AnchorDigest != ready.AnchorDigest ||
		discovery.Binding != ready.Binding || discovery.CutoverDigest != ready.CutoverDigest {
		t.Fatalf("incorrect discovery: %+v", discovery)
	}
	request(http.MethodGet, "/api/v2/state", "", nil, http.StatusNotFound, nil)
	var snapshot access.State
	if err := json.Unmarshal(pending.offer.Snapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	text, voice := snapshot.ChannelOrder[0], snapshot.ChannelOrder[1]
	request(http.MethodGet, "/api/v3/history/imported/"+text, "", nil, http.StatusUnauthorized, nil)
	open := func(signer testMemberSigner, device string) protectedSessionReceipt {
		t.Helper()
		var challenge protectedSessionChallenge
		request(http.MethodGet, "/api/v3/session/challenge", "", nil, http.StatusOK, &challenge)
		frame, err := signatureFrame("pawtalk-protected-session-v1", ready.ServerID, ready.CutoverDigest, ready.Binding, challenge.Nonce, device)
		if err != nil {
			t.Fatal(err)
		}
		input := protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce,
			Signature: b64.EncodeToString(ed25519.Sign(signer.device, frame))}
		var session protectedSessionReceipt
		request(http.MethodPost, "/api/v3/session/open", "", input, http.StatusCreated, &session)
		request(http.MethodPost, "/api/v3/session/open", "", input, http.StatusUnauthorized, nil)
		return session
	}
	session := open(keys, ready.OwnerDeviceID)
	if session.ProfileID != ready.OwnerProfileID {
		t.Fatalf("wrong initial session profile: %s", session.ProfileID)
	}
	var view access.Projection
	request(http.MethodGet, "/api/v3/state", session.Token, nil, http.StatusOK, &view)
	if len(view.Channels) != 2 || view.Channels[0].ID != text || view.Channels[1].ID != voice || view.Channels[0].Settings == nil {
		t.Fatalf("wrong initial channels: %+v", view.Channels)
	}
	var attestation access.PolicyAttestation
	request(http.MethodGet, "/api/v3/policy/attestations/1", session.Token, nil, http.StatusOK, &attestation)
	if attestation.Digest != ready.AnchorDigest || b64.EncodeToString(attestation.Signature) != approved.ScopeAttestation {
		t.Fatalf("initial scope attestation not installed with the anchor: %+v", attestation)
	}
	var rotations []access.PendingRotation
	request(http.MethodGet, "/api/v3/keys/rotations", session.Token, nil, http.StatusOK, &rotations)
	if len(rotations) != 1 || rotations[0].ChannelID != text || rotations[0].Purpose != access.LiveEpoch {
		t.Fatalf("expected live rotation before the initial archive can be generated: %+v", rotations)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM protected_rotation_tasks WHERE channel_id=? AND purpose='archive'", text).Scan(&count); err != nil || count != 1 {
		t.Fatalf("initial archive rotation not scheduled: %d, %v", count, err)
	}
	var imported importedProtectedPage
	request(http.MethodGet, "/api/v3/history/imported/"+text, session.Token, nil, http.StatusOK, &imported)
	if imported.First != 1 || imported.Messages == nil || len(imported.Messages) != 0 {
		t.Fatalf("new room returned imported history: %+v", imported)
	}
	request(http.MethodGet, "/api/v3/history/imported/"+strings.Repeat("d", 32), session.Token, nil, http.StatusForbidden, nil)
	request(http.MethodGet, "/api/v3/history/imported/"+text+"/link", session.Token, nil, http.StatusNotFound, nil)

	guestKeys := newTestMemberSigner(3)
	capability := newTestMemberSigner(2).device
	invite := access.InviteCreate{ID: strings.Repeat("b", 32),
		TokenHash: publicKeyID(capability.Public().(ed25519.PublicKey)), PolicyDigest: ready.AnchorDigest}
	actor := access.Principal{ProfileID: ready.OwnerProfileID, DeviceID: ready.OwnerDeviceID}
	inviteFrame, err := protectedInvitationFrame(ready.ServerID, actor, invite, 1)
	if err != nil {
		t.Fatal(err)
	}
	invite.Signature = ed25519.Sign(keys.device, inviteFrame)
	request(http.MethodPost, "/api/v3/invites", session.Token, invite, http.StatusOK, nil)
	redeem := access.InviteRedeem{InviteID: invite.ID, OperationID: strings.Repeat("c", 32), Nickname: "Invited guest",
		InvitePublicKey:  b64.EncodeToString(capability.Public().(ed25519.PublicKey)),
		ProfilePublicKey: b64.EncodeToString(guestKeys.root.Public().(ed25519.PublicKey)),
		DevicePublicKey:  b64.EncodeToString(guestKeys.device.Public().(ed25519.PublicKey)),
		AgreementKey:     testRecipientKey(t, 31)}
	redemption, err := protectedInviteRedemptionFrame(ready.ServerID, ready.CutoverDigest, redeem)
	if err != nil {
		t.Fatal(err)
	}
	redeem.ProfileSignature = b64.EncodeToString(ed25519.Sign(guestKeys.root, redemption))
	redeem.DeviceSignature = b64.EncodeToString(ed25519.Sign(guestKeys.device, redemption))
	redeem.InviteSignature = b64.EncodeToString(ed25519.Sign(capability, redemption))
	var admitted access.InviteAdmission
	request(http.MethodPost, "/api/v3/invites/redeem", "", redeem, http.StatusOK, &admitted)
	guest := open(guestKeys, admitted.DeviceID)
	var roster access.RosterPage
	request(http.MethodGet, "/api/v3/roster/text/"+text, guest.Token, nil, http.StatusOK, &roster)
	names := map[string]string{}
	for _, member := range roster.Members {
		names[member.ID] = member.Name
	}
	if len(roster.Members) != 2 || names[guest.ProfileID] != redeem.Nickname || names[session.ProfileID] != owner.Nickname {
		t.Fatalf("roster lost owner or invited guest names: %+v", roster)
	}
	request(http.MethodPost, "/api/v3/activity", "", map[string]bool{"away": false}, http.StatusUnauthorized, nil)
	request(http.MethodPost, "/api/v3/activity", guest.Token, map[string]string{"away": "true"}, http.StatusBadRequest, nil)
	request(http.MethodPost, "/api/v3/activity", guest.Token, map[string]bool{"away": true}, http.StatusOK, nil)
	request(http.MethodPost, "/api/v3/activity", session.Token, map[string]bool{"away": false}, http.StatusOK, nil)
	request(http.MethodGet, "/api/v3/roster/text/"+text, guest.Token, nil, http.StatusOK, &roster)
	presence := make(map[string]string)
	for _, member := range roster.Members {
		presence[member.ID] = member.Presence
	}
	if presence[guest.ProfileID] != "away" || presence[session.ProfileID] != "online" {
		t.Fatalf("unexpected presence for authorized members: %+v", presence)
	}
	offset.Add(protectedPresenceTTL.Milliseconds())
	request(http.MethodGet, "/api/v3/roster/text/"+text, guest.Token, nil, http.StatusOK, &roster)
	for _, member := range roster.Members {
		if member.Presence != "offline" {
			t.Fatalf("presence did not expire: %+v", member)
		}
	}
	request(http.MethodGet, "/api/v3/roster/members", guest.Token, nil, http.StatusForbidden, nil)
	request(http.MethodPost, "/api/v3/voice/"+voice+"/prepare", guest.Token, struct{}{}, http.StatusOK, nil)
	var claim protectedVoiceKeyClaim
	request(http.MethodPost, "/api/v3/voice/"+voice+"/key/claim", guest.Token, nil, http.StatusOK, &claim)
	if len(claim.Roster) != 1 || claim.Policy == nil || !validHexID(claim.Policy.OrderDigest, 64) ||
		len(claim.Policy.Recipients) != 1 || claim.Policy.Recipients[0].DeviceID != guest.DeviceID ||
		claim.Policy.Recipients[0].Proof.Count != 2 {
		t.Fatalf("new guest voice key claim omitted its scoped proof: %+v", claim)
	}
	commitment := strings.Repeat("e", 64)
	keyFrame, err := protectedVoiceKeyFrame(claim.Basis, claim.Roster[0], commitment)
	if err != nil {
		t.Fatal(err)
	}
	voiceOffer := protectedVoiceKeyOffer{Basis: claim.Basis, Commitment: commitment,
		Signature: ed25519.Sign(guestKeys.device, keyFrame),
		Packages:  map[string][]byte{guest.SessionID: bytes.Repeat([]byte{1}, access.EpochPackageSize)}}
	if err := runtime.publishVoiceKey(ctx, guest.Token, voice, voiceOffer); err != nil {
		t.Fatal(err)
	}
	var delivery protectedVoiceKeyDelivery
	request(http.MethodGet, "/api/v3/voice/"+voice+"/key", guest.Token, nil, http.StatusOK, &delivery)
	if delivery.Basis != claim.Basis || delivery.Policy == nil || len(delivery.Policy.Recipients) != 1 ||
		delivery.Policy.OrderDigest != claim.Policy.OrderDigest ||
		delivery.Policy.Recipients[0].Salt != claim.Policy.Recipients[0].Salt {
		t.Fatalf("voice delivery did not preserve the claim proof basis: %+v", delivery)
	}
	var grant memberVoice
	request(http.MethodPost, "/api/v3/voice/join", guest.Token,
		map[string]string{"channelId": voice, "keyEpoch": claim.Basis.EpochID}, http.StatusOK, &grant)
	claims, err := verifyMediaGrant(cfg, grant.Token, store.now())
	if err != nil || grant.Identity != guest.SessionID || !grant.E2EERequired ||
		claims.Video.CanPublish == nil || !*claims.Video.CanPublish {
		t.Fatalf("new guest did not receive scoped voice access: %v", err)
	}
	enrollment := checkProtectedRecoveryEnrollment(t, store.db, request, session, guest, guestKeys.device, func() {
		offset.Add(protectedRecoveryChallengeMillis + 1)
	})
	head, err := access.ReadPolicyHead(ctx, store.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	const banReason = "Synthetic recovery ban"
	banID := strings.Repeat("8", 32)
	banFrame, err := signatureFrame("pawtalk-protected-member-moderation-v1", ready.ServerID, ready.CutoverDigest,
		session.ProfileID, session.DeviceID, banID, head.Digest, access.BanPolicyMember, guest.ProfileID, banReason, "0")
	if err != nil {
		t.Fatal(err)
	}
	request(http.MethodPost, "/api/v3/moderation/member/ban", session.Token, protectedDepartureIntent{
		ProfileID: session.ProfileID, DeviceID: session.DeviceID, OperationID: banID, PolicyHead: head.Digest,
		Target: guest.ProfileID, Reason: banReason, Signature: b64.EncodeToString(ed25519.Sign(keys.device, banFrame)),
	}, http.StatusOK, nil)
	request(http.MethodPost, "/api/v3/recovery/enroll", guest.Token, enrollment, http.StatusUnauthorized, nil)
	request(http.MethodPost, "/api/v3/recovery/challenge", guest.Token, struct{}{}, http.StatusUnauthorized, nil)
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := access.VerifyActivatedPolicyChain(ctx, tx, ready.AnchorDigest, actor, verifyProtectedPolicyDraft); err != nil {
		t.Fatalf("policy replay rejected historical recovery after challenge expiry: %v", err)
	}
}

func signProtectedSelfhostFixture(t *testing.T, offer protectedSelfhostOffer, fingerprint, agreement string,
	keys testMemberSigner) protectedSelfhostApproval {
	t.Helper()
	actor := access.Principal{ProfileID: offer.OwnerProfileID, DeviceID: offer.OwnerDeviceID}
	policy, err := protectedPolicyFrame(offer.ServerID, actor, offer.Draft)
	if err != nil {
		t.Fatal(err)
	}
	root, err := signatureFrame("pawtalk-selfhost-owner-v1", offer.ServerID, fingerprint, offer.Binding, offer.CutoverDigest,
		actor.ProfileID, actor.DeviceID, agreement, offer.Draft.ResultDigest)
	if err != nil {
		t.Fatal(err)
	}
	policySignature := ed25519.Sign(keys.device, policy)
	anchor := publicKeyID(policySignature)
	scope, err := access.PolicyAttestationFrame(offer.ServerID, anchor, actor, access.PolicyAttestation{
		Revision: offer.Draft.Revision, Digest: anchor, Previous: offer.Draft.PreviousDigest,
		PolicyDigest: offer.Draft.ResultDigest, Root: offer.Draft.TextProjectionRoot, ProjectionVersion: offer.Draft.TextProjectionVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	return protectedSelfhostApproval{
		PolicySignature:  b64.EncodeToString(policySignature),
		ProfileSignature: b64.EncodeToString(ed25519.Sign(keys.root, root)),
		ScopeAttestation: b64.EncodeToString(ed25519.Sign(keys.device, scope)),
	}
}

func selfhostPinnedClient(certificate *x509.Certificate, fingerprint string) *http.Client {
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 || publicKeyID(state.PeerCertificates[0].Raw) != fingerprint {
				return errors.New("selfhost TLS pin mismatch")
			}
			return nil
		},
	}}}
}

func selfhostFixtureRequest(t *testing.T, client *http.Client, base, method, path, token string, input any, status int, output any) {
	t.Helper()
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, base+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		t.Fatalf("%s %s: got HTTP %d, want %d, body %s", method, path, response.StatusCode, status, raw)
	}
	if output != nil {
		if err := json.NewDecoder(response.Body).Decode(output); err != nil {
			t.Fatal(err)
		}
	}
}
