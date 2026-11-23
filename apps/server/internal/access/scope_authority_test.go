package access

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func scopeAuthorityTestKey(seed byte) ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, ed25519.SeedSize))
}

func scopeAuthorityTestPublicKey(key ed25519.PrivateKey) string {
	return hex.EncodeToString(key.Public().(ed25519.PublicKey))
}

func signScopeAuthorityTestLink(t *testing.T, binding ScopeAuthorityContext, link ScopeAuthorityLink, signer, consent ed25519.PrivateKey) ScopeAuthorityLink {
	t.Helper()
	frame, err := ScopeAuthorityLinkFrame(binding, link)
	if err != nil {
		t.Fatal(err)
	}
	link.Authorization = base64.RawURLEncoding.EncodeToString(ed25519.Sign(signer, frame))
	if consent != nil {
		frame, err := ScopeAuthorityDeviceConsentFrame(binding, link)
		if err != nil {
			t.Fatal(err)
		}
		link.DeviceProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(consent, frame))
	}
	return link
}

func signScopeOwnershipTestLink(t *testing.T, binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink,
	signer, consent ed25519.PrivateKey) ScopeAuthorityLink {
	t.Helper()
	frame, err := ScopeOwnershipOfferFrame(binding, currentOwner, link)
	if err != nil {
		t.Fatal(err)
	}
	link.Authorization = base64.RawURLEncoding.EncodeToString(ed25519.Sign(signer, frame))
	frame, err = ScopeOwnershipAcceptFrame(binding, currentOwner, link)
	if err != nil {
		t.Fatal(err)
	}
	link.DeviceProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(consent, frame))
	return link
}

func TestScopeAuthorityOwnershipTransfer(t *testing.T) {
	genesis, candidate, other, third := scopeAuthorityTestKey(81), scopeAuthorityTestKey(82), scopeAuthorityTestKey(83), scopeAuthorityTestKey(84)
	genesisRecovery, targetRecovery := scopeAuthorityTestKey(85), scopeAuthorityTestKey(86)
	genesisKey, candidateKey := scopeAuthorityTestPublicKey(genesis), scopeAuthorityTestPublicKey(candidate)
	binding := ScopeAuthorityContext{ServerID: strings.Repeat("1", 32), CutoverDigest: strings.Repeat("2", 64),
		AnchorDigest: strings.Repeat("3", 64), OwnerProfileID: strings.Repeat("4", 64), OwnerDeviceID: hexHash(genesis.Public().(ed25519.PublicKey))}
	target, originalRecoveryID, targetRecoveryID := strings.Repeat("5", 64), strings.Repeat("6", 64), strings.Repeat("7", 64)
	original := signScopeAuthorityTestLink(t, binding, ScopeAuthorityLink{Sequence: 1, Previous: binding.AnchorDigest, Action: AuthorizeScopeRecovery,
		Revision: 2, PolicyHead: binding.AnchorDigest, OperationID: strings.Repeat("8", 32), RecoveryID: originalRecoveryID,
		RecoveryKey: scopeAuthorityTestPublicKey(genesisRecovery), DeviceKey: genesisKey}, genesis, nil)
	parent, err := ScopeAuthorityLinkDigest(binding, original)
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{scopeAuthorityTestPublicKey(third), candidateKey, scopeAuthorityTestPublicKey(other)}
	claim, err := ScopeOwnershipCandidateClaim(keys, candidateKey, 5678)
	if err != nil {
		t.Fatal(err)
	}
	claim.CutoverDigest = binding.CutoverDigest
	transfer := signScopeOwnershipTestLink(t, binding, binding.OwnerProfileID, ScopeAuthorityLink{Sequence: 2, Previous: parent,
		Action: TransferScopeOwner, Revision: 7, PolicyHead: strings.Repeat("9", 64), OperationID: strings.Repeat("a", 32),
		RecoveryID: targetRecoveryID, RecoveryKey: scopeAuthorityTestPublicKey(targetRecovery), DeviceKey: candidateKey,
		TargetProfileID: target, Transfer: &claim}, genesis, candidate)
	state, err := VerifyScopeAuthorityChain(binding, genesisKey, []ScopeAuthorityLink{original, transfer})
	if err != nil || state.OwnerProfileID != target || state.DeviceKey != candidateKey || state.RecoveryID != targetRecoveryID || !state.OwnershipTransferred {
		t.Fatalf("ownership did not switch: %+v, %v", state, err)
	}
	reverseClaim, err := ScopeOwnershipCandidateClaim([]string{genesisKey}, genesisKey, 5679)
	if err != nil {
		t.Fatal(err)
	}
	reverseClaim.CutoverDigest = binding.CutoverDigest
	reverse := signScopeOwnershipTestLink(t, binding, target, ScopeAuthorityLink{Sequence: 3, Previous: state.Digest, Action: TransferScopeOwner,
		Revision: 8, PolicyHead: strings.Repeat("b", 64), OperationID: strings.Repeat("c", 32), DeviceKey: genesisKey,
		TargetProfileID: binding.OwnerProfileID, RecoveryID: originalRecoveryID, RecoveryKey: original.RecoveryKey, Transfer: &reverseClaim}, candidate, genesis)
	state, err = VerifyScopeAuthorityChain(binding, genesisKey, []ScopeAuthorityLink{original, transfer, reverse})
	if err != nil || state.OwnerProfileID != binding.OwnerProfileID || state.DeviceID != binding.OwnerDeviceID ||
		!usesTransferredPolicyAttestation(PolicyProof{Principal: Principal{binding.OwnerProfileID, binding.OwnerDeviceID}}, state) {
		t.Fatalf("returning owner did not preserve changed attestation authority: %+v, %v", state, err)
	}
	if state.Digest != "5335ef6a3fd1c8c52c16237bb8ae3b50e23966b5309f0770d139b3a1c8e44bdb" {
		t.Fatalf("unexpected terminal ownership digest %s", state.Digest)
	}
	for _, tc := range []struct {
		name   string
		change func(*ScopeAuthorityLink, *ScopeOwnershipClaim)
	}{
		{"other cutover", func(_ *ScopeAuthorityLink, claim *ScopeOwnershipClaim) { claim.CutoverDigest = strings.Repeat("d", 64) }},
		{"wrong count", func(_ *ScopeAuthorityLink, claim *ScopeOwnershipClaim) { claim.Count++ }},
		{"wrong sibling", func(_ *ScopeAuthorityLink, claim *ScopeOwnershipClaim) { claim.Siblings[0] = strings.Repeat("d", 64) }},
		{"uncommitted consent", func(link *ScopeAuthorityLink, _ *ScopeOwnershipClaim) { link.DeviceKey = reverse.DeviceKey }},
		{"wrong acceptance", func(link *ScopeAuthorityLink, _ *ScopeOwnershipClaim) { link.DeviceProof = reverse.DeviceProof }},
		{"wrong target", func(link *ScopeAuthorityLink, _ *ScopeOwnershipClaim) { link.TargetProfileID = strings.Repeat("d", 64) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			invalid, memberProof := transfer, claim
			memberProof.Siblings = append([]string{}, claim.Siblings...)
			invalid.Transfer = &memberProof
			tc.change(&invalid, &memberProof)
			if _, err := VerifyScopeAuthorityChain(binding, genesisKey, []ScopeAuthorityLink{original, invalid}); !errors.Is(err, ErrScopeAuthority) {
				t.Fatalf("invalid transfer accepted: %v", err)
			}
		})
	}
	if _, err := ScopeOwnershipCandidatesRoot([]string{candidateKey, candidateKey}); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("duplicate candidates accepted: %v", err)
	}
}

func TestScopeAuthorityChain(t *testing.T) {
	genesis, firstDevice, secondDevice := scopeAuthorityTestKey(1), scopeAuthorityTestKey(2), scopeAuthorityTestKey(3)
	firstRecovery, secondRecovery := scopeAuthorityTestKey(4), scopeAuthorityTestKey(5)
	genesisKey := scopeAuthorityTestPublicKey(genesis)
	binding := ScopeAuthorityContext{ServerID: strings.Repeat("1", 32), CutoverDigest: strings.Repeat("2", 64),
		AnchorDigest: strings.Repeat("3", 64), OwnerProfileID: strings.Repeat("4", 64),
		OwnerDeviceID: hexHash(genesis.Public().(ed25519.PublicKey))}
	newLink := func(sequence, revision int64, previous, action, recoveryID string, recovery, device ed25519.PrivateKey) ScopeAuthorityLink {
		return ScopeAuthorityLink{Sequence: sequence, Previous: previous, Action: action, Revision: revision,
			PolicyHead: fmt.Sprintf("%064x", revision-1), OperationID: fmt.Sprintf("%032x", revision),
			RecoveryID: recoveryID, RecoveryKey: scopeAuthorityTestPublicKey(recovery), DeviceKey: scopeAuthorityTestPublicKey(device)}
	}
	linkDigest := func(link ScopeAuthorityLink) string {
		t.Helper()
		digest, err := ScopeAuthorityLinkDigest(binding, link)
		if err != nil {
			t.Fatal(err)
		}
		return digest
	}
	firstRecoveryID, secondRecoveryID := strings.Repeat("5", 64), strings.Repeat("6", 64)
	authorizeFirst := signScopeAuthorityTestLink(t, binding,
		newLink(1, 2, binding.AnchorDigest, AuthorizeScopeRecovery, firstRecoveryID, firstRecovery, genesis), genesis, nil)
	transferFirst := signScopeAuthorityTestLink(t, binding,
		newLink(2, 9, linkDigest(authorizeFirst), RecoverPolicyDevice, firstRecoveryID, firstRecovery, firstDevice), firstRecovery, firstDevice)
	authorizeSecond := signScopeAuthorityTestLink(t, binding,
		newLink(3, 18, linkDigest(transferFirst), AuthorizeScopeRecovery, secondRecoveryID, secondRecovery, firstDevice), firstDevice, nil)
	transferSecond := signScopeAuthorityTestLink(t, binding,
		newLink(4, 42, linkDigest(authorizeSecond), RecoverPolicyDevice, secondRecoveryID, secondRecovery, secondDevice), secondRecovery, secondDevice)
	if digest := linkDigest(transferSecond); digest != "91ddbc511ccd4d2605b9720852c8adc650031ddc46f1487436e9c6ea98053697" {
		t.Fatalf("unexpected terminal digest %s", digest)
	}
	chain := []ScopeAuthorityLink{authorizeFirst, transferFirst, authorizeSecond, transferSecond}
	state, err := VerifyScopeAuthorityChain(binding, genesisKey, chain)
	want := ScopeAuthorityState{Sequence: 4, Revision: 42, Digest: linkDigest(transferSecond),
		DeviceID: hexHash(secondDevice.Public().(ed25519.PublicKey)), DeviceKey: scopeAuthorityTestPublicKey(secondDevice),
		RecoveryID: secondRecoveryID, RecoveryKey: scopeAuthorityTestPublicKey(secondRecovery), OwnerProfileID: binding.OwnerProfileID}
	if err != nil || state != want {
		t.Fatalf("state = %+v, err = %v, want %+v", state, err, want)
	}
	state, err = VerifyScopeAuthorityChain(binding, genesisKey, nil)
	if err != nil || state != (ScopeAuthorityState{Revision: 1, Digest: binding.AnchorDigest, DeviceID: binding.OwnerDeviceID, DeviceKey: genesisKey, OwnerProfileID: binding.OwnerProfileID}) {
		t.Fatalf("genesis state = %+v, err = %v", state, err)
	}
	if _, err := VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(firstDevice), nil); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("unpinned genesis = %v", err)
	}
	changedServer := binding
	changedServer.ServerID = strings.Repeat("9", 32)
	if _, err := VerifyScopeAuthorityChain(changedServer, genesisKey, chain); !errors.Is(err, ErrScopeAuthority) {
		t.Fatalf("other server chain = %v", err)
	}

	for _, test := range []struct {
		name    string
		index   int
		change  func(*ScopeAuthorityLink)
		signer  ed25519.PrivateKey
		consent ed25519.PrivateKey
	}{
		{"sequence gap", 1, func(link *ScopeAuthorityLink) { link.Sequence++ }, firstRecovery, firstDevice},
		{"fork", 1, func(link *ScopeAuthorityLink) { link.Previous = binding.AnchorDigest }, firstRecovery, firstDevice},
		{"revision rollback", 2, func(link *ScopeAuthorityLink) { link.Revision = 9 }, firstDevice, nil},
		{"duplicate operation", 2, func(link *ScopeAuthorityLink) { link.OperationID = authorizeFirst.OperationID }, firstDevice, nil},
		{"missing consent", 1, func(link *ScopeAuthorityLink) { link.DeviceProof = "" }, nil, nil},
		{"wrong consent", 1, nil, firstRecovery, secondDevice},
		{"retired owner authorization", 2, nil, genesis, nil},
		{"retired recovery authorization", 3, nil, firstRecovery, secondDevice},
		{"same device", 1, func(link *ScopeAuthorityLink) { link.DeviceKey = genesisKey }, firstRecovery, genesis},
		{"retired owner reassignment", 3, func(link *ScopeAuthorityLink) { link.DeviceKey = genesisKey }, secondRecovery, genesis},
		{"recovery key as owner enroller", 0, func(link *ScopeAuthorityLink) { link.DeviceKey = link.RecoveryKey }, firstRecovery, nil},
		{"active recovery key as new device", 1, func(link *ScopeAuthorityLink) { link.DeviceKey = link.RecoveryKey }, firstRecovery, firstRecovery},
		{"retired recovery as new device", 3, func(link *ScopeAuthorityLink) { link.DeviceKey = scopeAuthorityTestPublicKey(firstRecovery) }, secondRecovery, firstRecovery},
		{"transfer changed recovery ID", 1, func(link *ScopeAuthorityLink) { link.RecoveryID = secondRecoveryID }, firstRecovery, firstDevice},
		{"transfer changed recovery key", 1, func(link *ScopeAuthorityLink) { link.RecoveryKey = authorizeSecond.RecoveryKey }, firstRecovery, firstDevice},
		{"recovery ID reused", 2, func(link *ScopeAuthorityLink) { link.RecoveryID = firstRecoveryID }, firstDevice, nil},
		{"recovery key reused", 2, func(link *ScopeAuthorityLink) { link.RecoveryKey = authorizeFirst.RecoveryKey }, firstDevice, nil},
		{"identity point", 0, func(link *ScopeAuthorityLink) { link.RecoveryKey = "01" + strings.Repeat("00", 31) }, genesis, nil},
		{"off-curve point", 0, func(link *ScopeAuthorityLink) { link.RecoveryKey = "02" + strings.Repeat("00", 31) }, genesis, nil},
		{"tampered policy head", 0, func(link *ScopeAuthorityLink) { link.PolicyHead = strings.Repeat("7", 64) }, nil, nil},
		{"noncanonical signature", 0, func(link *ScopeAuthorityLink) { link.Authorization += "=" }, nil, nil},
		{"device proof on authorization", 0, func(link *ScopeAuthorityLink) { link.DeviceProof = transferFirst.DeviceProof }, nil, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := append([]ScopeAuthorityLink(nil), chain[:test.index+1]...)
			link := candidate[test.index]
			if test.change != nil {
				test.change(&link)
			}
			if test.signer != nil {
				link = signScopeAuthorityTestLink(t, binding, link, test.signer, test.consent)
			}
			candidate[test.index] = link
			if _, err := VerifyScopeAuthorityChain(binding, genesisKey, candidate); !errors.Is(err, ErrScopeAuthority) {
				t.Fatalf("invalid chain accepted, err = %v", err)
			}
		})
	}
}
