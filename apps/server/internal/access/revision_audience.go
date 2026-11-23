package access

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"math/bits"
	"slices"
)

const revisionAudienceDepth = 53

type revisionAudienceProof struct {
	Salt     string   `json:"salt"`
	Siblings []string `json:"siblings"`
}

var emptyRevisionAudience = sha256.Sum256([]byte("pawtalk-revision-audience-empty-v1"))

type revisionAudienceSet struct {
	id          [32]byte
	digest      [32]byte
	bit         int
	left, right *revisionAudienceSet
}

func revisionAudienceHash(tag, bit byte, left, right [32]byte) [32]byte {
	input := [66]byte{tag, bit}
	copy(input[2:34], left[:])
	copy(input[34:], right[:])
	return sha256.Sum256(input[:])
}

func audienceKeyBit(id [32]byte, bit int) bool {
	return id[bit/8]&(0x80>>uint(bit%8)) != 0
}

func (set *revisionAudienceSet) add(leaf *revisionAudienceSet) *revisionAudienceSet {
	if set == nil {
		return leaf
	}
	var split int
	for split < 256 && set.id[split/8] == leaf.id[split/8] {
		split += 8
	}
	if split < 256 {
		split += bits.LeadingZeros8(set.id[split/8] ^ leaf.id[split/8])
	}
	if split < set.bit {
		left, right := set, leaf
		if audienceKeyBit(set.id, split) {
			left, right = leaf, set
		}
		return &revisionAudienceSet{id: left.id, bit: split, left: left, right: right,
			digest: revisionAudienceHash(1, byte(split), left.digest, right.digest)}
	}
	if audienceKeyBit(leaf.id, set.bit) {
		set.right = set.right.add(leaf)
	} else {
		set.left = set.left.add(leaf)
		set.id = set.left.id
	}
	set.digest = revisionAudienceHash(1, byte(set.bit), set.left.digest, set.right.digest)
	return set
}

type revisionAudienceChange struct {
	first  uint64
	digest [32]byte
}

// The position tree commits the complete eligible set at each original
// position. A uniform subtree uses its common digest without expansion.
func revisionPositionRoot(changes []revisionAudienceChange, current [32]byte, start uint64, height int,
	position uint64, siblings []string) [32]byte {
	if len(changes) != 0 && changes[0].first == start {
		current, changes = changes[0].digest, changes[1:]
	}
	if len(changes) == 0 {
		if siblings != nil {
			for i := range height {
				siblings[i] = hex.EncodeToString(current[:])
			}
		}
		return current
	}
	middle := start + 1<<uint(height-1)
	split, _ := slices.BinarySearchFunc(changes, middle, func(change revisionAudienceChange, target uint64) int {
		switch {
		case change.first < target:
			return -1
		case change.first > target:
			return 1
		default:
			return 0
		}
	})
	rightStart := current
	if split != 0 {
		rightStart = changes[split-1].digest
	}
	var leftPath, rightPath []string
	if position < middle {
		leftPath = siblings
	} else {
		rightPath = siblings
	}
	left := revisionPositionRoot(changes[:split], current, start, height-1, position, leftPath)
	right := revisionPositionRoot(changes[split:], rightStart, middle, height-1, position, rightPath)
	if leftPath != nil {
		siblings[height-1] = hex.EncodeToString(right[:])
	} else if rightPath != nil {
		siblings[height-1] = hex.EncodeToString(left[:])
	}
	if left == right {
		return left
	}
	return revisionAudienceHash(2, byte(height), left, right)
}

func revisionAudienceCommitment(channel string, seed [32]byte, statements []TextRecipientStatement, position uint64) (string, *revisionAudienceProof, error) {
	limited := make([]TextRecipientStatement, 0, len(statements))
	for _, statement := range statements {
		if !statement.Archive {
			limited = append(limited, statement)
		}
	}
	slices.SortStableFunc(limited, func(a, b TextRecipientStatement) int { return cmp.Compare(a.FirstPosition, b.FirstPosition) })
	// A proof opens only the queried set's salt. Other sibling commitments
	// cannot be checked against guessed recipient sets using that salt.
	emptySalt := textRecipientBlind(seed, 2, channel, hex.EncodeToString(emptyRevisionAudience[:]))
	selectedSalt := emptySalt
	var set *revisionAudienceSet
	changes := make([]revisionAudienceChange, 0, len(limited))
	for _, recipient := range limited {
		var id, key [32]byte
		if _, err := hex.Decode(id[:], []byte(recipient.RecipientID)); err != nil {
			return "", nil, err
		}
		if _, err := hex.Decode(key[:], []byte(recipient.PublicKey)); err != nil {
			return "", nil, err
		}
		leaf := revisionAudienceHash(0, 0, id, key)
		set = set.add(&revisionAudienceSet{id: id, digest: leaf, bit: 256})
		salt := textRecipientBlind(seed, 2, channel, hex.EncodeToString(set.digest[:]))
		change := revisionAudienceChange{first: recipient.FirstPosition, digest: revisionAudienceHash(3, 0, salt, set.digest)}
		if change.first <= position {
			selectedSalt = salt
		}
		if len(changes) != 0 && changes[len(changes)-1].first == change.first {
			changes[len(changes)-1] = change
		} else {
			changes = append(changes, change)
		}
	}
	var path []string
	var proof *revisionAudienceProof
	if position != 0 {
		path = make([]string, revisionAudienceDepth)
		proof = &revisionAudienceProof{Salt: hex.EncodeToString(selectedSalt[:]), Siblings: path}
	}
	initial := revisionAudienceHash(3, 0, emptySalt, emptyRevisionAudience)
	root := revisionPositionRoot(changes, initial, 0, revisionAudienceDepth, position, path)
	return hex.EncodeToString(root[:]), proof, nil
}
