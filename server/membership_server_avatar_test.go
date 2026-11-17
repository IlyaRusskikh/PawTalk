package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestServerAvatarAuthorizationAndRevision(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	signer := newTestMemberSigner(2)
	activateTestMember(t, s, signer, "moderator")
	other := loginTestMember(t, s, signer)
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(make([]byte, 32))}
	raw, _ := json.Marshal(packet)
	input := serverAvatarPatch{Envelope: raw, ExpectedRevision: 1, RequestID: strings.Repeat("b", 32)}
	if err := s.patchServerAvatar(ctx, other.Token, input); err == nil {
		t.Fatal("moderator changed server avatar")
	}
	if err := s.patchServerAvatar(ctx, owner.Token, input); err != nil {
		t.Fatal(err)
	}
	state, err := s.state(ctx, other.Token)
	if err != nil || len(state.AvatarEnvelope) == 0 || state.AvatarAuthor != owner.Access.EffectiveProfileID || state.AvatarRevision != 2 {
		t.Fatal("avatar not shared", err)
	}
	input.RequestID = strings.Repeat("c", 32)
	if err = s.patchServerAvatar(ctx, owner.Token, input); err == nil {
		t.Fatal("stale edit overwrote avatar")
	}
	input.ExpectedRevision = 2
	input.Envelope = json.RawMessage("null")
	if err = s.patchServerAvatar(ctx, owner.Token, input); err != nil {
		t.Fatal(err)
	}
	state, err = s.state(ctx, owner.Token)
	if err != nil || len(state.AvatarEnvelope) != 0 {
		t.Fatal("avatar not removed", err)
	}
}

func TestServerAvatarAcceptsArtworkLargerThanInvitationKeys(t *testing.T) {
	s := testMembershipStore(t)
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	ctx := context.Background()
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(make([]byte, 8000))}
	raw, _ := json.Marshal(packet)
	if err := s.patchServerAvatar(ctx, owner.Token, serverAvatarPatch{Envelope: raw, ExpectedRevision: 1, RequestID: strings.Repeat("a", 32)}); err != nil {
		t.Fatal("valid artwork rejected", err)
	}
	packet.Ciphertext = b64.EncodeToString(make([]byte, 12017))
	bad, _ := json.Marshal(packet)
	if _, err := validateAvatarEnvelope(bad); err == nil {
		t.Fatal("oversized artwork accepted")
	}
}
