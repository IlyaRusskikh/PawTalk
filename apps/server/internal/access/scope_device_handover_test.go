package access

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func scopeHandoverFixture() (ScopeAuthorityContext, ed25519.PrivateKey, ed25519.PrivateKey) {
	origin, target := scopeAuthorityTestKey(91), scopeAuthorityTestKey(92)
	return ScopeAuthorityContext{
		ServerID: strings.Repeat("1", 32), CutoverDigest: strings.Repeat("2", 64),
		AnchorDigest: strings.Repeat("3", 64), OwnerProfileID: strings.Repeat("4", 64),
		OwnerDeviceID: hexHash(origin.Public().(ed25519.PublicKey)),
	}, origin, target
}

func scopeHandoverLink(previous string, revision, sequence int64, source, next ed25519.PrivateKey) ScopeAuthorityLink {
	return ScopeAuthorityLink{
		Action: MoveScopeDevice, Revision: revision, Sequence: sequence, Previous: previous,
		PolicyHead: fmt.Sprintf("%064x", revision-1), OperationID: fmt.Sprintf("%032x", revision),
		SourceDeviceID: hexHash(source.Public().(ed25519.PublicKey)), DeviceKey: scopeAuthorityTestPublicKey(next),
		ExpiresAt: 7890,
	}
}

func signScopeHandoverTestLink(t *testing.T, binding ScopeAuthorityContext, link ScopeAuthorityLink,
	authorizer, successor ed25519.PrivateKey) ScopeAuthorityLink {
	t.Helper()
	offer, err := ScopeDeviceHandoverFrame(binding, binding.OwnerProfileID, link)
	if err != nil {
		t.Fatal(err)
	}
	link.Authorization = base64.RawURLEncoding.EncodeToString(ed25519.Sign(authorizer, offer))
	consent, err := ScopeDeviceHandoverConsentFrame(binding, binding.OwnerProfileID, link)
	if err != nil {
		t.Fatal(err)
	}
	link.DeviceProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(successor, consent))
	return link
}

func TestScopeDeviceHandoverAndReturnPreserveSignerFloor(t *testing.T) {
	binding, origin, target := scopeHandoverFixture()
	link := scopeHandoverLink(binding.AnchorDigest, 2, 1, origin, target)
	offer, err := ScopeDeviceHandoverFrame(binding, binding.OwnerProfileID, link)
	if err != nil {
		t.Fatal(err)
	}
	want, err := SignatureFrame("pawtalk-scope-device-handover-v1", binding.ServerID, binding.CutoverDigest, binding.AnchorDigest,
		binding.OwnerProfileID, "1", binding.AnchorDigest, "2", link.PolicyHead, link.OperationID, binding.OwnerDeviceID,
		hexHash(target.Public().(ed25519.PublicKey)), scopeAuthorityTestPublicKey(target), "", "", "7890")
	if err != nil || !bytes.Equal(offer, want) {
		t.Fatalf("handover frame mismatch: %v", err)
	}
	first := signScopeHandoverTestLink(t, binding, link, origin, target)
	state, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{first})
	if err != nil || state.DeviceKey != first.DeviceKey || state.OwnerProfileID != binding.OwnerProfileID ||
		!state.SignerMoved || state.OwnershipTransferred || state.RecoveryID != "" || state.RecoveryKey != "" {
		t.Fatalf("handover changed more than the signer: %+v, %v", state, err)
	}
	firstDigest, err := ScopeDeviceHandoverLinkDigest(binding, binding.OwnerProfileID, first)
	if err != nil || firstDigest != state.Digest {
		t.Fatalf("handover digest = %q, %v", firstDigest, err)
	}
	second := signScopeHandoverTestLink(t, binding, scopeHandoverLink(firstDigest, 7, 2, target, origin), target, origin)
	state, err = VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{first, second})
	if err != nil || state.DeviceID != binding.OwnerDeviceID || state.OwnerProfileID != binding.OwnerProfileID ||
		state.Revision != second.Revision || !state.SignerMoved || state.OwnershipTransferred {
		t.Fatalf("return erased signer movement: %+v, %v", state, err)
	}
	if state.Digest != "3f77578100c7774dfb8a6a0b279153bd9d3b89e0085c4e4d65652b72a03d6e54" {
		t.Fatalf("unexpected handover chain digest %s", state.Digest)
	}
}

func TestScopeDeviceHandoverRejectsStaleOrMismatchedConsent(t *testing.T) {
	binding, origin, target := scopeHandoverFixture()
	other := scopeAuthorityTestKey(93)
	first := signScopeHandoverTestLink(t, binding, scopeHandoverLink(binding.AnchorDigest, 2, 1, origin, target), origin, target)
	firstDigest, err := ScopeDeviceHandoverLinkDigest(binding, binding.OwnerProfileID, first)
	if err != nil {
		t.Fatal(err)
	}
	link := scopeHandoverLink(firstDigest, 4, 2, target, other)
	stale, skipped, wrongSource, operationReplay := link, link, link, link
	stale.Previous = binding.AnchorDigest
	skipped.Sequence++
	wrongSource.SourceDeviceID = binding.OwnerDeviceID
	operationReplay.OperationID = first.OperationID
	tampered := signScopeHandoverTestLink(t, binding, link, target, other)
	tampered.PolicyHead = strings.Repeat("a", 64)
	expiryTampered := signScopeHandoverTestLink(t, binding, link, target, other)
	expiryTampered.ExpiresAt++
	noConsent := signScopeHandoverTestLink(t, binding, link, target, other)
	noConsent.DeviceProof = ""
	for _, tc := range []struct {
		name string
		link ScopeAuthorityLink
	}{
		{"stale chain predecessor", signScopeHandoverTestLink(t, binding, stale, target, other)},
		{"skipped sequence", signScopeHandoverTestLink(t, binding, skipped, target, other)},
		{"wrong source device explicitly signed by current key", signScopeHandoverTestLink(t, binding, wrongSource, target, other)},
		{"duplicate operation", signScopeHandoverTestLink(t, binding, operationReplay, target, other)},
		{"different policy predecessor", tampered},
		{"different deadline", expiryTampered},
		{"missing consent", noConsent},
		{"old signer approval", signScopeHandoverTestLink(t, binding, link, origin, other)},
		{"other installation consent", signScopeHandoverTestLink(t, binding, link, target, origin)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{first, tc.link}); !errors.Is(err, ErrScopeAuthority) {
				t.Fatalf("invalid handover accepted: %v", err)
			}
		})
	}
	for _, invalid := range []ScopeAuthorityLink{
		{Action: MoveScopeDevice, SourceDeviceID: link.SourceDeviceID}, // missing signed scope
		{Action: AuthorizeScopeRecovery, SourceDeviceID: link.SourceDeviceID},
	} {
		if _, err := ScopeDeviceHandoverFrame(binding, binding.OwnerProfileID, invalid); !errors.Is(err, ErrScopeAuthority) {
			t.Fatalf("invalid offer frame accepted: %v", err)
		}
	}
}

func TestScopeDeviceHandoverCannotReviveRetiredKeysOrAttachFieldsToPriorActions(t *testing.T) {
	binding, origin, target := scopeHandoverFixture()
	recovery := scopeAuthorityTestKey(96)
	recoveryID := strings.Repeat("5", 64)
	enrollment := ScopeAuthorityLink{
		Action: AuthorizeScopeRecovery, Sequence: 1, Revision: 2, Previous: binding.AnchorDigest, PolicyHead: binding.AnchorDigest,
		OperationID: strings.Repeat("a", 32), RecoveryID: recoveryID, RecoveryKey: scopeAuthorityTestPublicKey(recovery),
		DeviceKey: scopeAuthorityTestPublicKey(origin),
	}
	offered := enrollment
	offered.ExpiresAt = 7890
	if _, err := ScopeAuthorityLinkFrame(binding, offered); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("recovery frame accepted a handover deadline: %v", err)
	}
	enrollment = signScopeAuthorityTestLink(t, binding, enrollment, origin, nil)
	historyHead, err := ScopeAuthorityLinkDigest(binding, enrollment)
	if err != nil {
		t.Fatal(err)
	}
	restored := signScopeAuthorityTestLink(t, binding, ScopeAuthorityLink{
		Action: RecoverPolicyDevice, Sequence: 2, Revision: 3, Previous: historyHead, PolicyHead: strings.Repeat("6", 64),
		OperationID: strings.Repeat("b", 32), RecoveryID: recoveryID, RecoveryKey: scopeAuthorityTestPublicKey(recovery),
		DeviceKey: scopeAuthorityTestPublicKey(target),
	}, recovery, target)
	historyHead, err = ScopeAuthorityLinkDigest(binding, restored)
	if err != nil {
		t.Fatal(err)
	}
	revived := scopeHandoverLink(historyHead, 4, 3, target, origin)
	revived.RecoveryID, revived.RecoveryKey = enrollment.RecoveryID, enrollment.RecoveryKey
	revived = signScopeHandoverTestLink(t, binding, revived, target, origin)
	if _, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{enrollment, restored, revived}); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("handover revived a retired signing key: %v", err)
	}
	claim, err := ScopeOwnershipCandidateClaim([]string{scopeAuthorityTestPublicKey(target)}, scopeAuthorityTestPublicKey(target), 7890)
	if err != nil {
		t.Fatal(err)
	}
	claim.CutoverDigest = binding.CutoverDigest
	transfer := ScopeAuthorityLink{
		Action: TransferScopeOwner, Sequence: 1, Revision: 2, Previous: binding.AnchorDigest, PolicyHead: binding.AnchorDigest,
		OperationID: strings.Repeat("c", 32), RecoveryID: recoveryID, RecoveryKey: scopeAuthorityTestPublicKey(recovery),
		DeviceKey: scopeAuthorityTestPublicKey(target), TargetProfileID: strings.Repeat("7", 64), Transfer: &claim,
	}
	if _, err := ScopeOwnershipOfferFrame(binding, binding.OwnerProfileID, transfer); err != nil {
		t.Fatal(err)
	}
	transfer.SourceDeviceID = binding.OwnerDeviceID
	if _, err := ScopeOwnershipOfferFrame(binding, binding.OwnerProfileID, transfer); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("ownership frame accepted a handover source: %v", err)
	}
}

func TestScopeDeviceHandoverCanBootstrapButNotReplaceRecoveryPair(t *testing.T) {
	binding, origin, target := scopeHandoverFixture()
	recovery, other := scopeAuthorityTestKey(94), scopeAuthorityTestKey(95)
	first := scopeHandoverLink(binding.AnchorDigest, 3, 1, origin, target)
	first.RecoveryID, first.RecoveryKey = strings.Repeat("5", 64), scopeAuthorityTestPublicKey(recovery)
	first = signScopeHandoverTestLink(t, binding, first, origin, target)
	state, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{first})
	if err != nil || state.RecoveryID != first.RecoveryID || state.RecoveryKey != first.RecoveryKey {
		t.Fatalf("initial signed recovery pair was not retained: %+v, %v", state, err)
	}
	back := scopeHandoverLink(state.Digest, 4, 2, target, origin)
	back.RecoveryID, back.RecoveryKey = first.RecoveryID, first.RecoveryKey
	unchanged := signScopeHandoverTestLink(t, binding, back, target, origin)
	if _, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{first, unchanged}); err != nil {
		t.Fatal(err)
	}
	changedKey, changedID, blank, partial := back, back, back, back
	changedKey.RecoveryKey = scopeAuthorityTestPublicKey(other)
	changedID.RecoveryID = strings.Repeat("6", 64)
	blank.RecoveryID, blank.RecoveryKey = "", ""
	partial.RecoveryID = ""
	if _, err := ScopeDeviceHandoverFrame(binding, binding.OwnerProfileID, partial); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("half of a recovery pair accepted: %v", err)
	}
	for _, invalid := range []ScopeAuthorityLink{changedKey, changedID, blank} {
		invalid = signScopeHandoverTestLink(t, binding, invalid, target, origin)
		if _, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(origin), []ScopeAuthorityLink{first, invalid}); !errors.Is(err, ErrScopeAuthority) {
			t.Fatalf("handover changed the authorized recovery identity: %v", err)
		}
	}
}
