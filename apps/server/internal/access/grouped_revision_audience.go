package access

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
)

var emptyGroupedRevisionAudience = sha256.Sum256([]byte("pawtalk-revision-profile-empty-v1"))

func textRevisionProfileOpening(seed [32]byte, channel, profile string) RotationProfileOpening {
	outer := textRecipientBlind(seed, 18, channel, profile)
	inner := textRecipientBlind(seed, 19, channel, profile)
	return RotationProfileOpening{Salt: hex.EncodeToString(outer[:]), ContentSalt: hex.EncodeToString(inner[:])}
}

func textRevisionProfileMembersDigest(members [][2]string, contentSalt string) (string, error) {
	ordered := slices.Clone(members)
	slices.SortFunc(ordered, func(a, b [2]string) int { return cmp.Compare(a[0], b[0]) })
	previous := ""
	for _, member := range ordered {
		if !isDigest(member[0]) || !isDigest(member[1]) || member[0] == previous {
			return "", InvalidPolicy
		}
		previous = member[0]
	}
	raw, err := json.Marshal(ordered)
	if err != nil {
		return "", err
	}
	return hexHash(append([]byte("pawtalk-revision-profile-members-v1:"+contentSalt), raw...)), nil
}

type revisionProfileGroup struct {
	profile string
	first   uint64
	members [][2]string
}

func groupedRevisionAudienceCommitment(channel string, seed [32]byte, statements []TextRecipientStatement,
	position uint64) (string, *revisionAudienceProof, error) {
	groups := make(map[string]*revisionProfileGroup)
	for _, statement := range statements {
		if statement.Archive {
			continue
		}
		if !isDigest(statement.ProfileID) || statement.FirstPosition == 0 || statement.FirstPosition >= 1<<revisionAudienceDepth {
			return "", nil, InvalidPolicy
		}
		group := groups[statement.ProfileID]
		if group == nil {
			group = &revisionProfileGroup{profile: statement.ProfileID, first: statement.FirstPosition}
			groups[statement.ProfileID] = group
		} else if group.first != statement.FirstPosition {
			return "", nil, InvalidPolicy
		}
		group.members = append(group.members, [2]string{statement.RecipientID, statement.PublicKey})
	}
	ordered := make([]*revisionProfileGroup, 0, len(groups))
	for _, group := range groups {
		ordered = append(ordered, group)
	}
	slices.SortFunc(ordered, func(a, b *revisionProfileGroup) int {
		if order := cmp.Compare(a.first, b.first); order != 0 {
			return order
		}
		return cmp.Compare(a.profile, b.profile)
	})
	emptySalt := textRecipientBlind(seed, 20, channel, hex.EncodeToString(emptyGroupedRevisionAudience[:]))
	selectedSalt := emptySalt
	var set *revisionAudienceSet
	changes := make([]revisionAudienceChange, 0, len(ordered))
	for _, group := range ordered {
		var id [32]byte
		// Each profile was checked before grouping.
		_, _ = hex.Decode(id[:], []byte(group.profile))
		opening := textRevisionProfileOpening(seed, channel, group.profile)
		digest, err := textRevisionProfileMembersDigest(group.members, opening.ContentSalt)
		if err != nil {
			return "", nil, err
		}
		frame, err := SignatureFrame("pawtalk-revision-profile-v1", group.profile, opening.Salt, digest)
		if err != nil {
			return "", nil, err
		}
		set = set.add(&revisionAudienceSet{id: id, digest: sha256.Sum256(frame), bit: 256})
		salt := textRecipientBlind(seed, 20, channel, hex.EncodeToString(set.digest[:]))
		change := revisionAudienceChange{first: group.first, digest: revisionAudienceHash(3, 0, salt, set.digest)}
		if change.first <= position {
			selectedSalt = salt
		}
		if len(changes) != 0 && changes[len(changes)-1].first == change.first {
			changes[len(changes)-1] = change
		} else {
			changes = append(changes, change)
		}
	}
	initial := revisionAudienceHash(3, 0, emptySalt, emptyGroupedRevisionAudience)
	var proof *revisionAudienceProof
	var siblings []string
	if position > 0 {
		siblings = make([]string, revisionAudienceDepth)
		proof = &revisionAudienceProof{Salt: hex.EncodeToString(selectedSalt[:]), Siblings: siblings}
	}
	root := revisionPositionRoot(changes, initial, 0, revisionAudienceDepth, position, siblings)
	return hex.EncodeToString(root[:]), proof, nil
}
