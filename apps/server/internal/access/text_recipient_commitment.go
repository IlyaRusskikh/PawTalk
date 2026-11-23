package access

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
)

const TextRecipientProjectionVersion = 3
const TextRevisionProjectionVersion = 4
const TextRevisionAudienceVersion = 5
const TextRotationAudienceVersion = 6
const TextGroupedRotationProjectionVersion = 13
const TextGroupedArchiveRotationProjectionVersion = 14
const TextGroupedRevisionAudienceProjectionVersion = 15
const TextRoleViewDenyProjectionVersion = 16
const TextNewcomerAdmissionProjectionVersion = 17

func HasTextRecipientProjection(version int) bool {
	return version >= TextRecipientProjectionVersion && version <= ProfileRoleAuthorityProjectionVersion
}

type TextRecipientStatement struct {
	TextChannelKeyRecipient
	FirstPosition uint64 `json:"firstPosition"`
	CanSend       *bool  `json:"canSend,omitempty"`
}

type TextRecipientInclusion struct {
	Statement TextRecipientStatement `json:"statement"`
	Salt      string                 `json:"salt"`
	EpochPackageProof
}

type textRecipientLeaf struct {
	statement TextRecipientStatement
	rank      [32]byte
	salt      [32]byte
	hash      [32]byte
}

func textRecipientBlind(seed [32]byte, mode byte, channel, id string) [32]byte {
	mac := hmac.New(sha256.New, seed[:])
	mac.Write([]byte("pawtalk-text-recipient-commitment-v1"))
	mac.Write([]byte{mode, byte(len(channel))})
	mac.Write([]byte(channel))
	mac.Write([]byte(id))
	var value [32]byte
	mac.Sum(value[:0])
	return value
}

type textRecipientProjection struct {
	root, archiveAudience, limitedAudience string
	recipient                              *TextRecipientInclusion
	audienceProof                          *revisionAudienceProof
	groupedAudienceProof                   *revisionAudienceProof
	rotation                               *textRotationAudience
}

type textRotationAudience struct {
	Live            string `json:"live"`
	Archive         string `json:"archive"`
	LiveProfiles    string `json:"liveProfiles,omitempty"`
	ArchiveProfiles string `json:"archiveProfiles,omitempty"`
	LimitedProfiles string `json:"limitedProfiles,omitempty"`
	RoleViewDenies  string `json:"roleViewDenies,omitempty"`
	Newcomer        string `json:"newcomer,omitempty"`
}

func textRotationSalt(seed [32]byte, channel, purpose string) string {
	mode := byte(3)
	if purpose == ArchiveEpoch {
		mode = 4
	}
	salt := textRecipientBlind(seed, mode, channel, "")
	return hex.EncodeToString(salt[:])
}

func textRotationDigest(recipients map[string]KeyRecipient, salt string) (string, error) {
	raw, err := json.Marshal(recipients)
	if err != nil {
		return "", err
	}
	return hexHash(append([]byte("pawtalk-text-rotation-audience-v1:"+salt), raw...)), nil
}

type RotationProfileOpening struct {
	Salt        string `json:"salt"`
	ContentSalt string `json:"contentSalt"`
}

func textRotationProfileOpening(seed [32]byte, channel, purpose, profile string) RotationProfileOpening {
	// Opening the outer leaf can identify a removed profile without
	// revealing the salt that authenticates the profile's recipients.
	mode := byte(14)
	if purpose == ArchiveEpoch {
		mode = 16
	}
	leaf := textRecipientBlind(seed, mode, channel, profile)
	content := textRecipientBlind(seed, mode+1, channel, profile)
	return RotationProfileOpening{Salt: hex.EncodeToString(leaf[:]), ContentSalt: hex.EncodeToString(content[:])}
}

func textRotationProfilesDigest(recipients map[string]KeyRecipient, seed [32]byte, channel, purpose string) (string, error) {
	groups := make(map[string]map[string]KeyRecipient)
	for id, recipient := range recipients {
		group := groups[recipient.ProfileID]
		if group == nil {
			group = make(map[string]KeyRecipient)
			groups[recipient.ProfileID] = group
		}
		group[id] = recipient
	}
	leaves := make([][32]byte, 0, len(groups))
	for profile, group := range groups {
		opening := textRotationProfileOpening(seed, channel, purpose, profile)
		digest, err := textRotationDigest(group, opening.ContentSalt)
		if err != nil {
			return "", err
		}
		frame, err := SignatureFrame("pawtalk-"+purpose+"-rotation-profile-v1", profile, opening.Salt, digest)
		if err != nil {
			return "", err
		}
		leaves = append(leaves, sha256.Sum256(frame))
	}
	slices.SortFunc(leaves, func(a, b [32]byte) int { return bytes.Compare(a[:], b[:]) })
	root := sha256.New()
	root.Write([]byte("pawtalk-" + purpose + "-rotation-profiles-v1:"))
	for _, leaf := range leaves {
		root.Write(leaf[:])
	}
	return hex.EncodeToString(root.Sum(nil)), nil
}

func (s State) textRecipientCommitment(channel string, seed [32]byte, selected string, version int, position uint64) (textRecipientProjection, error) {
	var result textRecipientProjection
	projection, err := s.TextChannelKeyProjection(channel)
	if err != nil {
		return result, err
	}
	if version >= TextRevisionProjectionVersion {
		archived := make([]TextChannelKeyRecipient, 0, len(projection.Recipients))
		for _, recipient := range projection.Recipients {
			if recipient.Archive {
				archived = append(archived, recipient)
			}
		}
		raw, err := json.Marshal(archived)
		if err != nil {
			return result, err
		}
		result.archiveAudience = hexHash(raw)
	}
	var statements []TextRecipientStatement
	leaves := make([]textRecipientLeaf, 0, len(projection.Recipients))
	for _, recipient := range projection.Recipients {
		first := s.Admissions[channel][recipient.ProfileID].FirstPosition
		if first == 0 || first >= 1<<53 {
			return result, InvalidPolicy
		}
		statement := TextRecipientStatement{TextChannelKeyRecipient: recipient, FirstPosition: first}
		if version >= TextRevisionProjectionVersion {
			member := s.Members[recipient.ProfileID]
			member.TimeoutUntil = 0 // Run-time timeout is checked separately during publication.
			canSend := recipient.Kind == "device" && s.CheckGrant(member, s.scope(s.Channels[channel]), "message.send", 0) == Allowed
			statement.CanSend = &canSend
		}
		if version >= TextRevisionAudienceVersion {
			statements = append(statements, statement)
		}
		salt := textRecipientBlind(seed, 0, channel, recipient.RecipientID)
		raw, err := json.Marshal(statement)
		if err != nil {
			return result, err
		}
		hash := sha256.New()
		hash.Write([]byte("pawtalk-text-recipient-leaf-v1"))
		hash.Write(salt[:])
		hash.Write(raw)
		var leaf [32]byte
		hash.Sum(leaf[:0])
		leaves = append(leaves, textRecipientLeaf{statement: statement, salt: salt, hash: leaf,
			rank: textRecipientBlind(seed, 1, channel, recipient.RecipientID)})
	}
	slices.SortFunc(leaves, func(a, b textRecipientLeaf) int {
		if rank := bytes.Compare(a.rank[:], b.rank[:]); rank != 0 {
			return rank
		}
		return bytes.Compare(a.hash[:], b.hash[:])
	})
	hashes := make([][32]byte, 0, len(leaves))
	index := -1
	for i, leaf := range leaves {
		hashes = append(hashes, leaf.hash)
		if leaf.statement.RecipientID == selected {
			index = i
		}
	}
	root, siblings := foldCommitmentLeaves(hashes, index)
	if version >= TextRevisionAudienceVersion {
		result.limitedAudience, result.audienceProof, err = revisionAudienceCommitment(channel, seed, statements, position)
		if err != nil {
			return result, err
		}
		if version >= TextRotationAudienceVersion {
			live, archived := make(map[string]KeyRecipient), make(map[string]KeyRecipient)
			for _, entry := range projection.Recipients {
				live[entry.RecipientID] = s.KeyRecipients[entry.RecipientID]
				if entry.Archive {
					archived[entry.RecipientID] = live[entry.RecipientID]
				}
			}
			liveDigest, err := textRotationDigest(live, textRotationSalt(seed, channel, LiveEpoch))
			if err != nil {
				return result, err
			}
			archiveDigest, err := textRotationDigest(archived, textRotationSalt(seed, channel, ArchiveEpoch))
			if err != nil {
				return result, err
			}
			result.rotation = &textRotationAudience{Live: liveDigest, Archive: archiveDigest}
			material := root + result.archiveAudience + result.limitedAudience + liveDigest + archiveDigest
			domain := "pawtalk-text-revision-policy-v3:"
			if version >= TextGroupedRotationProjectionVersion {
				liveProfiles, err := textRotationProfilesDigest(live, seed, channel, LiveEpoch)
				if err != nil {
					return result, err
				}
				result.rotation.LiveProfiles = liveProfiles
				domain, material = "pawtalk-text-revision-policy-v4:", material+liveProfiles
			}
			if version >= TextGroupedArchiveRotationProjectionVersion {
				archiveProfiles, err := textRotationProfilesDigest(archived, seed, channel, ArchiveEpoch)
				if err != nil {
					return result, err
				}
				result.rotation.ArchiveProfiles = archiveProfiles
				domain, material = "pawtalk-text-revision-policy-v5:", material+archiveProfiles
			}
			if version >= TextGroupedRevisionAudienceProjectionVersion {
				limitedProfiles, proof, err := groupedRevisionAudienceCommitment(channel, seed, statements, position)
				if err != nil {
					return result, err
				}
				result.rotation.LimitedProfiles, result.groupedAudienceProof = limitedProfiles, proof
				domain, material = "pawtalk-text-revision-policy-v6:", material+limitedProfiles
			}
			if version >= TextRoleViewDenyProjectionVersion {
				roleViewDenies, _, err := s.roleViewDenyCommitment(channel, seed, "")
				if err != nil {
					return result, err
				}
				result.rotation.RoleViewDenies = roleViewDenies
				domain, material = "pawtalk-text-revision-policy-v7:", material+roleViewDenies
			}
			if version >= TextNewcomerAdmissionProjectionVersion {
				newcomer, _, err := s.textNewcomerAdmissionCommitment(channel, seed)
				if err != nil {
					return result, err
				}
				result.rotation.Newcomer = newcomer
				domain, material = "pawtalk-text-revision-policy-v8:", material+newcomer
			}
			root = hexHash([]byte(domain + material))
		} else {
			root = hexHash([]byte("pawtalk-text-revision-policy-v2:" + root + result.archiveAudience + result.limitedAudience))
		}
	} else if result.archiveAudience != "" {
		root = hexHash([]byte("pawtalk-text-revision-policy-v1:" + root + result.archiveAudience))
	}
	result.root = root
	if selected == "" {
		return result, nil
	}
	if index < 0 {
		return result, ErrEpochRecipients
	}
	entry := leaves[index]
	result.recipient = &TextRecipientInclusion{Statement: entry.statement, Salt: hex.EncodeToString(entry.salt[:]),
		EpochPackageProof: EpochPackageProof{Index: index, Count: len(leaves), Siblings: siblings}}
	return result, nil
}
