package access

import (
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"slices"
	"strconv"
)

// ProfileRoleAuthorityProjectionVersion adds selective role, key and roster
// evidence for updates to the recipients of a protected channel.
const ProfileRoleAuthorityProjectionVersion = 18

type ProfileRoleKey struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	PublicKey string `json:"publicKey"`
}

type ProfileRoleAuthorityOpening struct {
	Roles         []string         `json:"roles"`
	Grants        []string         `json:"grants"`
	Keys          []ProfileRoleKey `json:"keys"`
	RecoveryReady bool             `json:"recoveryReady"`
	RolesSalt     string           `json:"rolesSalt"`
	GrantsSalt    string           `json:"grantsSalt"`
	KeysSalt      string           `json:"keysSalt"`
	RecoverySalt  string           `json:"recoverySalt"`
}

type ProfileRoleAuthorityParts struct {
	Roles         string `json:"roles"`
	Grants        string `json:"grants"`
	Keys          string `json:"keys"`
	RecoveryReady string `json:"recoveryReady"`
}

type profileSigningKeyOpening struct {
	PublicKey string               `json:"publicKey"`
	Salt      string               `json:"salt"`
	Path      []ProfileRankSibling `json:"path"`
}

func scopedRoleKeys(state State) map[string][]ProfileRoleKey {
	keys := make(map[string][]ProfileRoleKey)
	for id, recipient := range state.KeyRecipients {
		keys[recipient.ProfileID] = append(keys[recipient.ProfileID], ProfileRoleKey{id, recipient.Kind, recipient.PublicKey})
	}
	for id, device := range state.PolicyDevices {
		if !device.Revoked {
			keys[device.ProfileID] = append(keys[device.ProfileID], ProfileRoleKey{id, "signing", device.PublicKey})
		}
	}
	return keys
}

func (s State) profileRoleAuthority(seed [32]byte, subject Subject, keys []ProfileRoleKey) ProfileRoleAuthorityOpening {
	roles := grantSet(subject.Roles)
	grants := grantSet(s.Roles[Everyone].Grants)
	for role := range roles {
		maps.Copy(grants, grantSet(s.Roles[role].Grants))
	}
	salt := func(kind byte) string {
		value := textRecipientBlind(seed, kind, profileRankProjectionID, subject.ID)
		return hex.EncodeToString(value[:])
	}
	return ProfileRoleAuthorityOpening{
		Roles:         append([]string{}, slices.Sorted(maps.Keys(roles))...),
		Grants:        append([]string{}, slices.Sorted(maps.Keys(grants))...),
		Keys:          append([]ProfileRoleKey{}, keys...),
		RecoveryReady: s.RecoveryReady[subject.ID],
		RolesSalt:     salt(24), GrantsSalt: salt(25), KeysSalt: salt(26), RecoverySalt: salt(29),
	}
}

func profileRoleFieldsDigest(domain, salt string, fields []string) (string, error) {
	if !isDigest(salt) {
		return "", InvalidPolicy
	}
	hash := sha256.New()
	for _, field := range append([]string{domain, salt}, fields...) {
		frame, err := SignatureFrame(field)
		if err != nil {
			return "", InvalidPolicy
		}
		hash.Write(frame)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (p ProfileRoleAuthorityOpening) parts() (ProfileRoleAuthorityParts, error) {
	roles, err := profileRoleFieldsDigest("pawtalk-profile-role-ids-v1", p.RolesSalt, p.Roles)
	if err != nil {
		return ProfileRoleAuthorityParts{}, err
	}
	grants, err := profileRoleFieldsDigest("pawtalk-profile-base-grants-v1", p.GrantsSalt, p.Grants)
	if err != nil {
		return ProfileRoleAuthorityParts{}, err
	}
	keys, _, err := p.keyTree("")
	if err != nil {
		return ProfileRoleAuthorityParts{}, err
	}
	keyDigest := keys.atDepth(0)
	ready, err := profileRoleFieldsDigest("pawtalk-profile-role-recovery-v1", p.RecoverySalt, []string{strconv.FormatBool(p.RecoveryReady)})
	if err != nil {
		return ProfileRoleAuthorityParts{}, err
	}
	return ProfileRoleAuthorityParts{Roles: roles, Grants: grants, Keys: hex.EncodeToString(keyDigest[:]), RecoveryReady: ready}, nil
}

// A signing proof reveals one blinded leaf. The master salt stays with the
// full group opening used to reconcile a complete recipient set.
func (p ProfileRoleAuthorityOpening) keyTree(signingDevice string) (*scopedChannelRuleNode, *profileSigningKeyOpening, error) {
	return p.keyTreeFor("signing", signingDevice)
}

func (p ProfileRoleAuthorityOpening) keyTreeFor(kind, id string) (*scopedChannelRuleNode, *profileSigningKeyOpening, error) {
	if !isDigest(p.KeysSalt) {
		return nil, nil, InvalidPolicy
	}
	leaves := make([]sparsePolicyLeaf, 0, len(p.Keys))
	var opening *profileSigningKeyOpening
	var selected [32]byte
	for _, key := range p.Keys {
		if !isDigest(key.ID) || !isDigest(key.PublicKey) || (key.Kind != "signing" && key.Kind != "device" && key.Kind != "recovery") {
			return nil, nil, InvalidPolicy
		}
		saltFrame, _ := SignatureFrame("pawtalk-profile-role-key-salt-v1", p.KeysSalt, key.Kind, key.ID)
		salt := hexHash(saltFrame)
		positionFrame, _ := SignatureFrame("pawtalk-profile-role-key-position-v1", salt, key.Kind, key.ID)
		keyFrame, _ := SignatureFrame("pawtalk-profile-role-key-leaf-v1", salt, key.Kind, key.ID, key.PublicKey)
		position := sha256.Sum256(positionFrame)
		leaves = append(leaves, sparsePolicyLeaf{position, sha256.Sum256(keyFrame)})
		if key.Kind == kind && key.ID == id {
			opening = &profileSigningKeyOpening{PublicKey: key.PublicKey, Salt: salt}
			selected = position
		}
	}
	tree, err := buildSparsePolicyTree(leaves)
	if err != nil {
		return nil, nil, err
	}
	if opening != nil {
		opening.Path = sparsePolicyOpening(tree, selected)
	}
	return tree, opening, nil
}

func (p ProfileRoleAuthorityOpening) digest() (string, error) {
	parts, err := p.parts()
	if err != nil {
		return "", err
	}
	frame, err := SignatureFrame("pawtalk-profile-role-authority-v1", parts.Roles, parts.Grants, parts.Keys, parts.RecoveryReady)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}
