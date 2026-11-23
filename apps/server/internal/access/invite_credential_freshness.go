package access

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"sort"
	"strconv"
)

type inviteCredential struct {
	kind string
	id   string
}

type InviteAdmissionScopeOpening struct {
	Issuers     string                 `json:"issuers"`
	Credentials string                 `json:"credentials"`
	Ranks       string                 `json:"ranks"`
	Catalogue   string                 `json:"catalogue,omitempty"`
	Rosters     string                 `json:"rosters,omitempty"`
	Inclusion   ChannelPolicyInclusion `json:"inclusion"`
}

func (s State) inviteAdmissionProjection(seed [32]byte) (InviteAdmissionScopeOpening, error) {
	issuers, _, err := s.inviteIssuerCommitment(seed, Principal{})
	if err != nil {
		return InviteAdmissionScopeOpening{}, err
	}
	credentials, _, err := s.inviteCredentialCommitment(nil)
	if err != nil {
		return InviteAdmissionScopeOpening{}, err
	}
	return InviteAdmissionScopeOpening{Issuers: issuers, Credentials: credentials}, nil
}

func (opening InviteAdmissionScopeOpening) digest() (string, error) {
	frame, err := SignatureFrame("pawtalk-invite-admission-projection-v1", opening.Issuers, opening.Credentials)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func (s State) inviteAdmissionScopeOpening(seed [32]byte, version int) (InviteAdmissionScopeOpening, error) {
	if version < TextNewcomerAdmissionProjectionVersion {
		return InviteAdmissionScopeOpening{}, ChannelRestricted
	}
	tree, err := s.textProjectionTree(hex.EncodeToString(seed[:]), version)
	if err != nil {
		return InviteAdmissionScopeOpening{}, err
	}
	opening := tree.inviteAdmission
	opening.Inclusion, err = tree.proof(profileRankProjectionID)
	return opening, err
}

type InviteUseOpening struct {
	Count          int64                     `json:"count"`
	IssueSignature string                    `json:"issueSignature,omitempty"`
	Path           []InviteCredentialSibling `json:"path"`
}

type InviteCredentialSibling struct {
	Depth  int    `json:"depth"`
	Digest string `json:"digest"`
}

// A nonmembership proof walks a public deterministic path. Only nonempty
// sibling roots are disclosed, with no identifiers or positions of neighbors.
var inviteCredentialPresent = sha256.Sum256([]byte("pawtalk-invite-credential-present-v1"))

var inviteCredentialEmpty = func() [257][32]byte {
	var roots [257][32]byte
	roots[256] = sha256.Sum256([]byte("pawtalk-invite-credential-empty-v1"))
	for depth := 255; depth >= 0; depth-- {
		roots[depth] = inviteCredentialBranch(roots[depth+1], roots[depth+1])
	}
	return roots
}()

func inviteCredentialBranch(left, right [32]byte) [32]byte {
	var fields [65]byte
	fields[0] = 1
	copy(fields[1:33], left[:])
	copy(fields[33:], right[:])
	return sha256.Sum256(fields[:])
}

func (credential inviteCredential) position() ([32]byte, error) {
	valid := isDigest(credential.id) && (credential.kind == "profile" || credential.kind == "device" || credential.kind == "agreement")
	if credential.kind == "invite-use" {
		valid = validInviteHex(credential.id, 32)
	}
	if !valid {
		return [32]byte{}, InvalidPolicy
	}
	frame, err := SignatureFrame("pawtalk-invite-credential-position-v1", credential.kind, credential.id)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(frame), nil
}

type inviteCredentialLeaf struct {
	position [32]byte
	digest   [32]byte
}

type inviteCredentialOpening struct {
	credential inviteCredential
	position   [32]byte
	path       []InviteCredentialSibling
}

func (s State) inviteCredentials() []inviteCredential {
	var credentials []inviteCredential
	for id := range s.Members {
		credentials = append(credentials, inviteCredential{"profile", id})
	}
	for id := range s.MemberRemovals {
		credentials = append(credentials, inviteCredential{"profile", id})
	}
	for profile, effective := range s.ProfileBindings {
		credentials = append(credentials, inviteCredential{"profile", profile}, inviteCredential{"profile", effective})
	}
	for id := range s.PolicyDevices {
		credentials = append(credentials, inviteCredential{"device", id})
	}
	for id := range s.DetachedPolicyDevices {
		credentials = append(credentials, inviteCredential{"device", id})
	}
	for id := range s.ProfileDeviceOrigins {
		credentials = append(credentials, inviteCredential{"device", id})
	}
	for id, recipient := range s.KeyRecipients {
		credentials = append(credentials, inviteCredential{"agreement", recipient.PublicKey})
		if recipient.Kind == "device" {
			credentials = append(credentials, inviteCredential{"device", id})
		}
	}
	for id, retired := range s.RetiredRecipientKeys {
		if retired {
			credentials = append(credentials, inviteCredential{"agreement", id})
		}
	}
	return credentials
}

func (s State) inviteCredentialCommitment(candidate *inviteCredential) (string, []InviteCredentialSibling, error) {
	return s.inviteCredentialProof(candidate, true)
}

func (s State) inviteCredentialProof(candidate *inviteCredential, requireAbsent bool) (string, []InviteCredentialSibling, error) {
	var requests map[inviteCredential]bool
	if candidate != nil {
		requests = map[inviteCredential]bool{*candidate: requireAbsent}
	}
	root, paths, err := s.inviteCredentialOpenings(requests)
	if candidate == nil || err != nil {
		return root, nil, err
	}
	return root, paths[*candidate], nil
}

// inviteCredentialOpenings builds the signed sparse tree once for all openings.
// A true request requires the corresponding credential to be absent.
func (s State) inviteCredentialOpenings(requests map[inviteCredential]bool) (string, map[inviteCredential][]InviteCredentialSibling, error) {
	credentials := s.inviteCredentials()
	leaves := make([]inviteCredentialLeaf, 0, len(credentials)+len(s.InvitationUses))
	for _, credential := range credentials {
		position, err := credential.position()
		if err != nil {
			return "", nil, err
		}
		leaves = append(leaves, inviteCredentialLeaf{position, inviteCredentialPresent})
	}
	for id, use := range s.InvitationUses {
		position, err := (inviteCredential{"invite-use", id}).position()
		if err != nil || use.Count <= 0 || use.IssueSignature == "" {
			return "", nil, InvalidPolicy
		}
		frame, err := SignatureFrame("pawtalk-invite-use-leaf-v1", strconv.FormatInt(use.Count, 10), use.IssueSignature)
		if err != nil {
			return "", nil, err
		}
		leaves = append(leaves, inviteCredentialLeaf{position, sha256.Sum256(frame)})
	}
	slices.SortFunc(leaves, func(a, b inviteCredentialLeaf) int { return bytes.Compare(a.position[:], b.position[:]) })
	leaves = slices.Compact(leaves)
	openings := make([]inviteCredentialOpening, 0, len(requests))
	for credential, requireAbsent := range requests {
		position, err := credential.position()
		if err != nil {
			return "", nil, err
		}
		if _, found := slices.BinarySearchFunc(leaves, position, func(a inviteCredentialLeaf, b [32]byte) int {
			return bytes.Compare(a.position[:], b[:])
		}); requireAbsent && found {
			return "", nil, ErrInviteConflict
		}
		openings = append(openings, inviteCredentialOpening{credential: credential, position: position, path: []InviteCredentialSibling{}})
	}
	slices.SortFunc(openings, func(a, b inviteCredentialOpening) int { return bytes.Compare(a.position[:], b.position[:]) })
	root := inviteCredentialTree(leaves, openings, 0)
	if len(openings) == 0 {
		return hex.EncodeToString(root[:]), nil, nil
	}
	paths := make(map[inviteCredential][]InviteCredentialSibling, len(openings))
	for _, opening := range openings {
		paths[opening.credential] = opening.path
	}
	return hex.EncodeToString(root[:]), paths, nil
}

func inviteCredentialTree(leaves []inviteCredentialLeaf, openings []inviteCredentialOpening, depth int) [32]byte {
	if len(leaves) == 0 {
		return inviteCredentialEmpty[depth]
	}
	if depth == 256 {
		return leaves[0].digest
	}
	boundary := sort.Search(len(leaves), func(index int) bool { return profileRankBit(leaves[index].position, depth) })
	split := sort.Search(len(openings), func(index int) bool { return profileRankBit(openings[index].position, depth) })
	leftOpenings, rightOpenings := openings[:split], openings[split:]
	left := inviteCredentialTree(leaves[:boundary], leftOpenings, depth+1)
	right := inviteCredentialTree(leaves[boundary:], rightOpenings, depth+1)
	appendInviteCredentialSibling(leftOpenings, right, depth)
	appendInviteCredentialSibling(rightOpenings, left, depth)
	return inviteCredentialBranch(left, right)
}

func appendInviteCredentialSibling(openings []inviteCredentialOpening, sibling [32]byte, depth int) {
	if len(openings) == 0 || sibling == inviteCredentialEmpty[depth+1] {
		return
	}
	entry := InviteCredentialSibling{Depth: depth, Digest: hex.EncodeToString(sibling[:])}
	for i := range openings {
		openings[i].path = append(openings[i].path, entry)
	}
}
