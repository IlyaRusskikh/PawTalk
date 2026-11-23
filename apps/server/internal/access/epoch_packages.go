package access

import (
	"bytes"
	"cmp"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"maps"
	"slices"
)

const EpochPackageSize = 80 // X25519 encapsulation, a 32-byte secret and GCM tag.
const RecoveryEpochOpeningKeySize = ed25519.PublicKeySize
const RecoveryEpochPackageSize = EpochPackageSize + ed25519.SeedSize + RecoveryEpochOpeningKeySize

type EpochPackage struct {
	RecipientID string
	Purpose     string
	Ciphertext  []byte
}

// PackagesDigest canonicalizes the manifest order independently of submission order.
func PackagesDigest(packages []EpochPackage) (string, error) {
	ordered, err := orderedPackages(packages)
	if err != nil {
		return "", err
	}
	digest, _ := packageTree(ordered, -1)
	return digest, nil
}

type EpochPackageProof struct {
	Index    int      `json:"index"`
	Count    int      `json:"count"`
	Siblings []string `json:"siblings"`
}

func ProveEpochPackage(packages []EpochPackage, recipientID, purpose string) (string, EpochPackageProof, error) {
	ordered, err := orderedPackages(packages)
	if err != nil {
		return "", EpochPackageProof{}, err
	}
	index := slices.IndexFunc(ordered, func(item EpochPackage) bool {
		return item.RecipientID == recipientID && item.Purpose == purpose
	})
	if index < 0 {
		return "", EpochPackageProof{}, ErrEpochRecipients
	}
	digest, siblings := packageTree(ordered, index)
	return digest, EpochPackageProof{Index: index, Count: len(ordered), Siblings: siblings}, nil
}

func orderedPackages(packages []EpochPackage) ([]EpochPackage, error) {
	if len(packages) == 0 || len(packages) > 8192 {
		return nil, ErrEpochRecipients
	}
	for _, item := range packages {
		if !isDigest(item.RecipientID) || (item.Purpose != "live" && item.Purpose != "archive") ||
			(len(item.Ciphertext) != EpochPackageSize && len(item.Ciphertext) != RecoveryEpochPackageSize) {
			return nil, ErrEpochRecipients
		}
	}
	ordered := slices.Clone(packages)
	slices.SortFunc(ordered, func(a, b EpochPackage) int {
		if byRecipient := cmp.Compare(a.RecipientID, b.RecipientID); byRecipient != 0 {
			return byRecipient
		}
		return cmp.Compare(a.Purpose, b.Purpose)
	})
	return ordered, nil
}

func packageTree(packages []EpochPackage, selected int) (string, []string) {
	leaves := make([][32]byte, len(packages))
	for index, item := range packages {
		recipient, _ := hex.DecodeString(item.RecipientID)
		var input [2 + 32 + RecoveryEpochPackageSize]byte
		if item.Purpose == "live" {
			input[1] = 1
		}
		copy(input[2:], recipient)
		copy(input[34:], item.Ciphertext)
		leaves[index] = sha256.Sum256(input[:34+len(item.Ciphertext)])
	}
	return foldCommitmentLeaves(leaves, selected)
}

// Callers separate their leaf hash domains before folding.
func foldCommitmentLeaves(leaves [][32]byte, selected int) (string, []string) {
	count := len(leaves)
	siblings := make([]string, 0)
	for len(leaves) > 1 {
		if selected >= 0 {
			if sibling := selected ^ 1; sibling < len(leaves) {
				siblings = append(siblings, hex.EncodeToString(leaves[sibling][:]))
			}
			selected /= 2
		}
		for index := 0; index+1 < len(leaves); index += 2 {
			leaves[index/2] = commitmentParent(leaves[index], leaves[index+1])
		}
		if len(leaves)%2 != 0 {
			leaves[len(leaves)/2] = leaves[len(leaves)-1]
		}
		leaves = leaves[:(len(leaves)+1)/2]
	}
	var top [32]byte
	if count != 0 {
		top = leaves[0]
	}
	return countedCommitmentRoot(count, top), siblings
}

func commitmentParent(left, right [32]byte) [32]byte {
	var input [65]byte
	input[0] = 1
	copy(input[1:], left[:])
	copy(input[33:], right[:])
	return sha256.Sum256(input[:])
}

func countedCommitmentRoot(count int, top [32]byte) string {
	var root [37]byte
	root[0] = 2
	binary.BigEndian.PutUint32(root[1:], uint32(count))
	copy(root[5:], top[:])
	digest := sha256.Sum256(root[:])
	return hex.EncodeToString(digest[:])
}

func (s State) checkEpochPackages(digest, purpose string, recipients map[string]KeyRecipient, packages []EpochPackage) error {
	actual, err := PackagesDigest(packages)
	if err != nil || digest != actual {
		return ErrEpochRecipients
	}
	expected := maps.Clone(recipients)
	for _, item := range packages {
		recipient, exists := expected[item.RecipientID]
		if item.Purpose != purpose || !exists {
			return ErrEpochRecipients
		}
		if s.requiresEpochOpeningProof(item.RecipientID, recipient) {
			if len(item.Ciphertext) != RecoveryEpochPackageSize ||
				!ValidRecoveryEpochOpeningKey(item.Ciphertext[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:]) {
				return ErrEpochRecipients
			}
		} else if len(item.Ciphertext) != EpochPackageSize {
			return ErrEpochRecipients
		}
		delete(expected, item.RecipientID)
	}
	if len(expected) != 0 {
		return ErrEpochRecipients
	}
	return nil
}

// ValidRecoveryEpochOpeningKey excludes noncanonical encodings and
// small-order keys before Ed25519 signature verification. In particular a
// package must not use the identity point as a key that proves possession.
func ValidRecoveryEpochOpeningKey(key []byte) bool {
	if len(key) != RecoveryEpochOpeningKeySize {
		return false
	}
	y := [RecoveryEpochOpeningKeySize]byte(key)
	y[31] &= 0x7f // Ignore the sign of x when comparing the y-coordinate.
	if y[31] == 0x7f && y[0] >= 0xed && bytes.Equal(y[1:31], bytes.Repeat([]byte{0xff}, 30)) {
		return false
	}
	// The distinct canonical y-coordinates of the small-order points.
	// https://github.com/jedisct1/libsodium/blob/1.0.18-RELEASE/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c#L964
	switch hex.EncodeToString(y[:]) {
	case zeroKey,
		"0100000000000000000000000000000000000000000000000000000000000000",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f":
		return false
	default:
		return true
	}
}
