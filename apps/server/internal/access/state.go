package access

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
)

type Channel struct {
	Kind         string
	CategoryID   string
	Synchronized bool
	ACL          ACL
	Settings     *ChannelSettings `json:",omitempty"`
	NextPosition uint64
}

type PolicyDevice struct {
	ProfileID string
	PublicKey string
	Revoked   bool `json:",omitempty"`
}

// State holds only authorization data. The protected protocol binds the
// actor ID to a verified device before invoking a policy transaction.
type State struct {
	RoleSnapshot
	Categories       map[string]ACL
	CategoryNames    map[string]string `json:",omitempty"`
	CategoryOrder    []string          `json:",omitempty"`
	CategoryCreators map[string]string `json:",omitempty"`
	Channels         map[string]Channel
	ChannelOrder     []string `json:",omitempty"`
	RecoveryReady    map[string]bool
	Admissions       map[string]map[string]Admission // channel, effective profile
	EpochWindows     map[string]EpochWindow
	ArchiveHeads     map[string]uint64
	// KeyRecipients is part of the policy snapshot, supplied by verified
	// enrollment. A storage row alone must not enroll a recipient.
	KeyRecipients              map[string]KeyRecipient
	RetiredRecipientKeys       map[string]bool
	PolicyDevices              map[string]PolicyDevice
	ProfileBindings            map[string]string                      `json:",omitempty"`
	ImportedProfileBindings    bool                                   `json:",omitempty"`
	ProfileDeviceOrigins       map[string]string                      `json:",omitempty"`
	DetachedPolicyDevices      map[string]string                      `json:",omitempty"`
	RetiredChannels            map[string]bool                        `json:",omitempty"`
	VoiceRestrictions          map[string]map[string]VoiceRestriction `json:",omitempty"`
	InvitationUses             map[string]InvitePolicyUse             `json:",omitempty"`
	MemberRemovals             map[string]MemberRemoval               `json:",omitempty"`
	InheritedBanLifts          map[string]bool                        `json:",omitempty"`
	RecoveryIdentities         map[string]RecoveryIdentity            `json:",omitempty"`
	RetiredRecoverySigningKeys map[string]bool                        `json:",omitempty"`
	PolicyAnchored             bool
}

func (s State) hasPolicyDevice(principal Principal) bool {
	entry := s.PolicyDevices[principal.DeviceID]
	return !entry.Revoked && entry.ProfileID == principal.ProfileID && principal.ProfileID != ""
}

func (s State) validPolicyDevices() bool {
	for id, entry := range s.PolicyDevices {
		if entry.Revoked || !signingKeyMatches(id, entry.PublicKey) || !s.Members[entry.ProfileID].Active {
			return false
		}
	}
	for id, entry := range s.KeyRecipients {
		if entry.Kind == "device" && !s.hasPolicyDevice(Principal{ProfileID: entry.ProfileID, DeviceID: id}) {
			return false
		}
	}
	return true
}

func signingKeyMatches(id, publicKey string) bool {
	if !isDigest(publicKey) {
		return false
	}
	key, _ := hex.DecodeString(publicKey)
	digest := sha256.Sum256(key)
	return hex.EncodeToString(digest[:]) == id
}

func (s State) scope(channel Channel) Scope {
	category := s.Categories[channel.CategoryID]
	return Scope{Kind: channel.Kind, Local: &channel.ACL, Category: &category, Synchronized: channel.Synchronized}
}

func (s State) validState() bool {
	if !s.RoleSnapshot.valid() || !s.validRecoveryIdentities() || !s.validProfileBindings() || !s.validDetachedPolicyDevices() {
		return false
	}
	keys := make(map[string]bool)
	for id, entry := range s.KeyRecipients {
		recovery := s.RecoveryIdentities[entry.ProfileID]
		if !isDigest(id) || !isDigest(entry.PublicKey) || entry.PublicKey == zeroKey ||
			keys[entry.PublicKey] || s.RetiredRecipientKeys[entry.PublicKey] ||
			s.Members[entry.ProfileID].ID == "" || (entry.Kind != "device" && entry.Kind != "recovery") ||
			(entry.Kind == "recovery" && (recovery.ID == "" && !s.RecoveryReady[entry.ProfileID] ||
				recovery.ID != "" && (recovery.ID != id || recovery.AgreementKey != entry.PublicKey))) {
			return false
		}
		keys[entry.PublicKey] = true
	}
	for id, acl := range s.Categories {
		if id == "" || !s.validACL(acl, "category") {
			return false
		}
	}
	for id, channel := range s.Channels {
		_, hasCategory := s.Categories[channel.CategoryID]
		if id == "" || s.RetiredChannels[id] || (channel.Kind != "text" && channel.Kind != "voice") || channel.NextPosition == 0 ||
			(channel.CategoryID != "" && !hasCategory) || (channel.Synchronized && !hasCategory) ||
			!s.validACL(channel.ACL, channel.Kind) || (channel.Settings != nil && !channel.Settings.valid(channel.Kind)) {
			return false
		}
		if channel.Synchronized && (len(channel.ACL.Profiles) != 0 || len(channel.ACL.Roles) != 0) {
			return false
		}
	}
	for id, profiles := range s.VoiceRestrictions {
		if (id != serverVoiceRestriction && s.Channels[id].Kind != "voice") || len(profiles) == 0 {
			return false
		}
		for profile, restriction := range profiles {
			if s.Members[profile].ID == "" || restriction == (VoiceRestriction{}) ||
				(restriction.MediaDeafened && (id != serverVoiceRestriction || restriction.Deafened)) {
				return false
			}
		}
	}
	return true
}

func (s State) validACL(acl ACL, kind string) bool {
	validOverwrite := func(overwrite Overwrite) bool {
		for _, list := range [][]string{overwrite.Allow, overwrite.Deny} {
			for _, grant := range list {
				entry, known := permissions[grant]
				if !known || entry.Scope == "server" || (kind != "category" && !fitsScope(entry.Scope, kind)) {
					return false
				}
			}
		}
		for _, id := range overwrite.Allow {
			if slices.Contains(overwrite.Deny, id) {
				return false
			}
		}
		return true
	}
	for id, overwrite := range acl.Roles {
		if _, exists := s.Roles[id]; !exists || !validOverwrite(overwrite) {
			return false
		}
	}
	for id, overwrite := range acl.Profiles {
		if _, exists := s.Members[id]; !exists || !validOverwrite(overwrite) {
			return false
		}
	}
	return true
}

func (s *State) refreshAdmissions() {
	current := make(map[string]map[string]Admission, len(s.Channels))
	for id, channel := range s.Channels {
		if channel.Kind != "text" {
			continue
		}
		profiles := make(map[string]Admission)
		scope := s.scope(channel)
		for profile, subject := range s.Members {
			if s.CheckGrant(subject, scope, ChannelView, 0) == Allowed {
				profiles[profile] = s.Admissions[id][profile].Update(true, channel.NextPosition)
			}
		}
		current[id] = profiles
	}
	s.Admissions = current
}

// CanDeliver checks current channel visibility and, for content, the original
// message position. A zero position denotes channel metadata only.
func (s State) CanDeliver(profileID, channelID string, originalPosition uint64) bool {
	channel, exists := s.Channels[channelID]
	if !exists {
		return false
	}
	subject := s.Members[profileID]
	scope := s.scope(channel)
	if s.CheckGrant(subject, scope, ChannelView, 0) != Allowed {
		return false
	}
	if originalPosition == 0 {
		return true
	}
	fullHistory := s.CheckGrant(subject, scope, "history.full", 0) == Allowed
	return channel.Kind == "text" && originalPosition < channel.NextPosition &&
		s.Admissions[channelID][profileID].CanRead(originalPosition, fullHistory)
}

func (s State) canUseDevice(principal Principal) bool {
	if !s.PolicyAnchored {
		return true
	}
	entry := s.KeyRecipients[principal.DeviceID]
	return entry.Kind == "device" && entry.ProfileID == principal.ProfileID
}
