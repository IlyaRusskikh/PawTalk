package access

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"slices"
)

const maxInviteIssuerProofCount = 8192

type InviteIssuerProof struct {
	SigningKey string            `json:"signingKey"`
	Salt       string            `json:"salt"`
	Proof      EpochPackageProof `json:"proof"`
}

// inviteIssuerCommitment commits every eligible device in this signed policy.
// A witness opens only the selected effective profile and device.
func (s State) inviteIssuerCommitment(seed [32]byte, selected Principal) (string, *InviteIssuerProof, error) {
	var leaves [][32]byte
	var selectedLeaf [32]byte
	var witness *InviteIssuerProof
	for id, device := range s.PolicyDevices {
		if device.Revoked || s.ProfileBindings[device.ProfileID] != "" ||
			s.CheckGrant(s.Members[device.ProfileID], Scope{}, "invite.create", 0) != Allowed {
			continue
		}
		if !isDigest(device.ProfileID) || !signingKeyMatches(id, device.PublicKey) {
			return "", nil, InvalidPolicy
		}
		salt := textRecipientBlind(seed, 23, "", id)
		saltHex := hex.EncodeToString(salt[:])
		frame, err := SignatureFrame("pawtalk-invite-issuer-v1", id, device.ProfileID, device.PublicKey, saltHex)
		if err != nil {
			return "", nil, err
		}
		leaf := sha256.Sum256(frame)
		leaves = append(leaves, leaf)
		if selected.DeviceID == id && selected.ProfileID == device.ProfileID {
			selectedLeaf = leaf
			witness = &InviteIssuerProof{SigningKey: device.PublicKey, Salt: saltHex}
		}
	}
	slices.SortFunc(leaves, func(a, b [32]byte) int { return bytes.Compare(a[:], b[:]) })
	index := -1
	if witness != nil && len(leaves) <= maxInviteIssuerProofCount {
		index = slices.Index(leaves, selectedLeaf)
	}
	root, siblings := foldCommitmentLeaves(leaves, index)
	if index < 0 {
		return root, nil, nil
	}
	witness.Proof = EpochPackageProof{Index: index, Count: len(leaves), Siblings: siblings}
	return root, witness, nil
}
