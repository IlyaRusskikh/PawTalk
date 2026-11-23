package main

import (
	"bytes"
	"crypto/ed25519"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

type protectedRuntimeConfig struct {
	Protocol             int    `json:"apiProtocolVersion"`
	Schema               int    `json:"dataSchemaVersion"`
	ServerID             string `json:"serverId"`
	Name                 string `json:"name"`
	Binding              string `json:"binding"`
	CutoverDigest        string `json:"cutoverDigest"`
	AnchorDigest         string `json:"anchorDigest"`
	E2EERequired         bool   `json:"e2eeRequired"`
	Voice                bool   `json:"protectedVoice"`
	VoiceControls        bool   `json:"protectedVoiceControls,omitempty"`
	VoiceChannelControls bool   `json:"protectedVoiceChannelControls,omitempty"`
	VoiceEvents          bool   `json:"protectedVoiceEvents,omitempty"`
	VoiceMediaDeafen     bool   `json:"protectedVoiceMediaDeafen,omitempty"`
	Events               bool   `json:"protectedEvents,omitempty"`
	ComposerEvents       bool   `json:"protectedComposerEvents,omitempty"`
	MessageDelivery      bool   `json:"protectedMessageDelivery,omitempty"`
	Presence             bool   `json:"protectedPresence,omitempty"`
	PollResultTasks      bool   `json:"protectedPollResultTasks,omitempty"`
	MediaVariants        bool   `json:"protectedMediaVariants,omitempty"`
	DeviceRevocation     bool   `json:"protectedDeviceRevocation,omitempty"`
	ProfileAvatar        bool   `json:"protectedProfileAvatar,omitempty"`
	OwnerProfileAvatar   bool   `json:"protectedOwnerProfileAvatar,omitempty"`
	MemberProfileAvatars bool   `json:"protectedMemberProfileAvatars,omitempty"`
	LegacyAvatar         bool   `json:"protectedLegacyAvatar,omitempty"`
	ExplicitAdminView    bool   `json:"protectedExplicitAdminView,omitempty"`
	OwnRoleStyle         bool   `json:"protectedOwnRoleStyle,omitempty"`
	IdentityKey          string `json:"identityKey"`
	IdentitySignature    string `json:"identitySignature"`
}

func (p *protectedRuntime) configHTTP(voice bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		community, err := access.ReadCommunityName(r.Context(), p.store.db)
		if err != nil {
			memberFail(w, err)
			return
		}
		var seed, key []byte
		if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_seed,identity_public_key FROM server_state WHERE id=1").
			Scan(&seed, &key); err != nil {
			memberFail(w, err)
			return
		}
		defer clear(seed)
		invalid := memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
		if len(seed) != ed25519.SeedSize || len(key) != ed25519.PublicKeySize ||
			!validHexID(p.anchorDigest, 64) || publicKeyID(key)[:32] != p.serverID {
			memberFail(w, invalid)
			return
		}
		private := ed25519.NewKeyFromSeed(seed)
		defer clear(private)
		if !bytes.Equal(private[ed25519.SeedSize:], key) {
			memberFail(w, invalid)
			return
		}
		result := protectedRuntimeConfig{Protocol: 3, Schema: protectedDataSchemaVersion, ServerID: p.serverID,
			Name: community.Name, Binding: p.store.protectedBinding, CutoverDigest: p.cutoverDigest, AnchorDigest: p.anchorDigest,
			E2EERequired: true, Voice: voice, VoiceControls: voice, VoiceChannelControls: voice, VoiceEvents: voice, VoiceMediaDeafen: voice, Events: true, ComposerEvents: true, MessageDelivery: true, Presence: true, PollResultTasks: true, MediaVariants: true, LegacyAvatar: p.importedProfileNames != nil,
			DeviceRevocation: true, ProfileAvatar: true, OwnerProfileAvatar: true, MemberProfileAvatars: true, ExplicitAdminView: true,
			OwnRoleStyle: true, IdentityKey: b64.EncodeToString(key)}
		frame, err := signatureFrame("pawtalk-server-v3", result.ServerID, strconv.Itoa(result.Protocol), strconv.Itoa(result.Schema),
			result.Name, result.Binding, result.CutoverDigest, result.AnchorDigest,
			strconv.FormatBool(result.E2EERequired), strconv.FormatBool(result.Voice))
		if err != nil {
			memberFail(w, err)
			return
		}
		result.IdentitySignature = b64.EncodeToString(ed25519.Sign(private, frame))
		respond(w, http.StatusOK, result)
	}
}
