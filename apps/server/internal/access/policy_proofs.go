package access

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
)

var ErrPolicySignatureRequired = errors.New("signed policy mutation required")
var ErrRecipientKey = errors.New("invalid or conflicting recipient key")

const (
	AnchorPolicy         = "policy.anchor"
	EnrollRecipientKey   = "recipient.enroll"
	RevokeRecipientKey   = "recipient.revoke"
	UpdatePolicyRoles    = "roles.update"
	EnrollPolicyDevice   = "device.enroll"
	RevokePolicyDevice   = "device.revoke"
	AdmitInviteMember    = "member.admit"
	RedeemPolicyInvite   = "member.redeem"
	LeavePolicyMember    = "member.leave"
	KickPolicyMember     = "member.kick"
	BanPolicyMember      = "member.ban"
	LiftPolicyMemberBan  = "member.unban"
	UpdateChannelACL     = "channel.acl.update"
	UpdateCategoryACL    = "category.acl.update"
	SyncChannelACL       = "channel.acl.sync"
	MovePolicyChannel    = "channel.move"
	CreatePolicyChannel  = "channel.create"
	EditPolicyChannel    = "channel.settings.update"
	CopyPolicyChannel    = "channel.copy"
	DeletePolicyChannel  = "channel.delete"
	CreatePolicyCategory = "category.create"
	CopyPolicyCategory   = "category.copy"
	RenamePolicyCategory = "category.settings.update"
	DeletePolicyCategory = "category.delete"
	OrderPolicyCategory  = "category.order"
	OrderPolicyChannel   = "channel.order"
	ChangeVoiceMute      = "voice.mute"
	ChangeVoiceDeafen    = "voice.deafen"
)

type PolicyDeviceChange struct {
	DeviceID  string
	PublicKey string
	Consent   []byte
}

type PolicyResourceChange struct {
	ID                   string
	ACL                  *ACL                          `json:",omitempty"`
	CategoryID           string                        `json:",omitempty"`
	Mode                 MoveAccess                    `json:",omitempty"`
	Channel              *ChannelDefinition            `json:",omitempty"`
	Settings             *ChannelSettings              `json:",omitempty"`
	SourceID             string                        `json:",omitempty"`
	TargetProfileID      string                        `json:",omitempty"`
	VoiceTargetSessionID string                        `json:",omitempty"`
	Lift                 bool                          `json:",omitempty"`
	Name                 string                        `json:",omitempty"`
	AnchorID             string                        `json:",omitempty"`
	After                bool                          `json:",omitempty"`
	MixedOrder           bool                          `json:",omitempty"`
	Admission            *InvitePolicyAdmission        `json:",omitempty"`
	Departure            *MemberPolicyDeparture        `json:",omitempty"`
	Recovery             *RecoveryPolicyEnrollment     `json:",omitempty"`
	RecoveryConfirmation *RecoveryPolicyConfirmation   `json:",omitempty"`
	RecoveryDevice       *RecoveryPolicyDevice         `json:",omitempty"`
	DeviceBinding        *PolicyDeviceBinding          `json:",omitempty"`
	OwnershipTransfer    *ScopeAuthorityLink           `json:",omitempty"`
	ProfileLink          *ProfilePolicyLink            `json:",omitempty"`
	ProfileUnlink        *ProfilePolicyUnlink          `json:",omitempty"`
	ScopeDeviceHandover  *ScopeDevicePolicyHandover    `json:",omitempty"`
	SettingsEdit         *PolicyChannelSettingsEdit    `json:",omitempty"`
	ACLRoleEdit          *PolicyChannelACLRoleEdit     `json:",omitempty"`
	ACLPersonalEdit      *PolicyChannelACLPersonalEdit `json:",omitempty"`
	RolesEdit            *ScopedRoleEdit               `json:",omitempty"`
}

type PolicyDraft struct {
	OperationID           string
	Action                string
	Revision              int64
	PreviousDigest        string
	ResultDigest          string
	TextProjectionRoot    string `json:",omitempty"`
	TextProjectionSeed    string `json:",omitempty"`
	TextProjectionVersion int    `json:",omitempty"`
	PublicKey             string
	RoleUpdate            *RolePolicyUpdate
	DeviceChange          *PolicyDeviceChange   `json:",omitempty"`
	ResourceChange        *PolicyResourceChange `json:",omitempty"`
	Signature             []byte
}

type PolicyProof struct {
	Principal Principal
	Draft     PolicyDraft
	Digest    string
}

type VerifyPolicyDraft func(context.Context, SessionQuery, Principal, PolicyDraft) error

func readPolicyHead(ctx context.Context, query SessionQuery) (PolicyProof, error) {
	proof, err := readStoredPolicyProof(ctx, query, query.QueryRowContext(ctx,
		"SELECT revision,operation_id,digest,record FROM protected_policy_proofs ORDER BY revision DESC LIMIT 1"))
	if errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, nil
	}
	return proof, err
}

func readStoredPolicyProof(ctx context.Context, query SessionQuery, row *sql.Row) (PolicyProof, error) {
	var proof PolicyProof
	var raw []byte
	var digest, operationID string
	var revision int64
	if err := row.Scan(&revision, &operationID, &digest, &raw); err != nil {
		return proof, err
	}
	if json.Unmarshal(raw, &proof) != nil || len(proof.Draft.Signature) != 64 ||
		proof.Draft.Revision != revision || proof.Draft.OperationID != operationID ||
		!validTextProjectionFields(proof.Draft) {
		return PolicyProof{}, ErrPolicyConflict
	}
	hash := sha256.Sum256(proof.Draft.Signature)
	if hex.EncodeToString(hash[:]) != digest {
		return PolicyProof{}, ErrPolicyConflict
	}
	var previous string
	if revision > 1 {
		if err := query.QueryRowContext(ctx, "SELECT digest FROM protected_policy_proofs WHERE revision=?", revision-1).Scan(&previous); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return PolicyProof{}, ErrPolicyConflict
			}
			return PolicyProof{}, err
		}
	}
	if proof.Draft.PreviousDigest != previous {
		return PolicyProof{}, ErrPolicyConflict
	}
	proof.Digest = digest
	return proof, nil
}

func validTextProjectionFields(draft PolicyDraft) bool {
	if draft.TextProjectionRoot == "" && draft.TextProjectionSeed == "" {
		return draft.TextProjectionVersion == 0
	}
	return isDigest(draft.TextProjectionRoot) && isDigest(draft.TextProjectionSeed) &&
		(draft.TextProjectionVersion == 0 || HasTextRecipientProjection(draft.TextProjectionVersion))
}

func checkPolicyHead(state State, revision int64, head PolicyProof) error {
	if !state.PolicyAnchored && head.Digest == "" {
		return nil
	}
	if !state.PolicyAnchored || head.Digest == "" || head.Draft.Revision != revision {
		return ErrPolicyConflict
	}
	digest, err := state.PolicyDigest()
	if err != nil {
		return err
	}
	if digest != head.Draft.ResultDigest {
		return ErrPolicyConflict
	}
	return nil
}

func preparePolicyDraft(state *State, revision int64, head PolicyProof, actor Principal, request PolicyDraft) (PolicyDraft, error) {
	var draft PolicyDraft
	if !validRotationID(request.OperationID) || !isDigest(actor.DeviceID) {
		return draft, InvalidAction
	}
	if request.Action != RedeemPolicyInvite && !state.Members[actor.ProfileID].Active {
		return draft, Inactive
	}
	if err := checkPolicyHead(*state, revision, head); err != nil {
		return draft, err
	}
	draft = PolicyDraft{Action: request.Action, OperationID: request.OperationID, Revision: revision, PreviousDigest: head.Digest,
		TextProjectionSeed: request.TextProjectionSeed, TextProjectionVersion: request.TextProjectionVersion,
		PublicKey: request.PublicKey, RoleUpdate: request.RoleUpdate,
		DeviceChange: request.DeviceChange, ResourceChange: request.ResourceChange}
	if request.Action == AnchorPolicy {
		if request.PublicKey != "" || request.RoleUpdate != nil || request.DeviceChange != nil || request.ResourceChange != nil || state.PolicyAnchored || revision != 1 ||
			actor.ProfileID != state.Owner || !state.hasPolicyDevice(actor) || !state.validPolicyDevices() ||
			len(state.EpochWindows) != 0 || len(state.ArchiveHeads) != 0 || len(state.InvitationUses) != 0 ||
			len(state.MemberRemovals) != 0 || len(state.InheritedBanLifts) != 0 ||
			!state.validProfileBindings() || (!state.ImportedProfileBindings &&
			(len(state.ProfileBindings) != 0 || len(state.ProfileDeviceOrigins) != 0)) {
			return PolicyDraft{}, ErrPolicyConflict
		}
	} else {
		if !state.PolicyAnchored {
			return PolicyDraft{}, ErrPolicySignatureRequired
		}
		if request.Action != RedeemPolicyInvite && request.Action != RecoverPolicyDevice && !state.hasPolicyDevice(actor) {
			return PolicyDraft{}, Inactive
		}
		switch request.Action {
		case UpdatePolicyRoles:
			if request.RoleUpdate == nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyRoles(actor.ProfileID, *request.RoleUpdate); err != nil {
				return PolicyDraft{}, err
			}
			state.refreshAdmissions()
		case EditScopedRoles:
			update, err := state.scopedRoleEdit(actor, request, head)
			if err != nil {
				return PolicyDraft{}, err
			}
			if err := state.applyRoles(actor.ProfileID, update); err != nil {
				return PolicyDraft{}, err
			}
			state.refreshAdmissions()
		case EnrollPolicyDevice, RevokePolicyDevice:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange == nil || request.ResourceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.changePolicyDevice(actor, request.Action, *request.DeviceChange); err != nil {
				return PolicyDraft{}, err
			}
		case AdmitInviteMember, RedeemPolicyInvite:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.admitInviteMember(actor, *request.ResourceChange, request.Action == RedeemPolicyInvite); err != nil {
				return PolicyDraft{}, err
			}
		case LeavePolicyMember, KickPolicyMember, BanPolicyMember, LiftPolicyMemberBan:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyMemberDeparture(actor, request.Action, *request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
		case EnrollPolicyRecovery:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyRecoveryEnrollment(actor, *request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
		case ConfirmPolicyRecovery:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyRecoveryConfirmation(actor, *request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
		case RecoverPolicyDevice:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyRecoveryDevice(actor, *request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
		case BindPolicyDevice:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyDeviceBinding(actor, request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
		case TransferPolicyOwnership:
			if request.RoleUpdate != nil || !validRecoveryProof(request.PublicKey, 32) || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyOwnerTransfer(actor, *request.ResourceChange, revision+1, head.Digest, request.OperationID); err != nil {
				return PolicyDraft{}, err
			}
		case LinkPolicyProfiles, UnlinkPolicyProfile:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyProfileLinking(actor, request.Action, request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
		case MoveScopeDevice:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.checkScopeDeviceHandover(actor, request, revision+1, head.Digest); err != nil {
				return PolicyDraft{}, err
			}
		case EditScopedChannelSettings:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if _, err := state.checkScopedChannelSettings(actor, request, head); err != nil {
				return PolicyDraft{}, err
			}
			if err := state.editChannel(actor.ProfileID, request.ResourceChange.ID, *request.ResourceChange.Settings); err != nil {
				return PolicyDraft{}, err
			}
		case EditScopedChannelACLRoleRules:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyScopedChannelACLRoleRules(actor, request, head); err != nil {
				return PolicyDraft{}, err
			}
			state.refreshAdmissions()
		case EditScopedChannelACLPersonal:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.applyScopedChannelACLPersonal(actor, request, head); err != nil {
				return PolicyDraft{}, err
			}
			state.refreshAdmissions()
		case UpdateChannelACL, UpdateCategoryACL, SyncChannelACL, MovePolicyChannel,
			CreatePolicyChannel, EditPolicyChannel, CopyPolicyChannel, DeletePolicyChannel, CreatePolicyCategory, CopyPolicyCategory,
			RenamePolicyCategory, DeletePolicyCategory, OrderPolicyCategory, OrderPolicyChannel,
			ChangeVoiceMute, ChangeVoiceDeafen:
			if request.RoleUpdate != nil || request.PublicKey != "" || request.DeviceChange != nil || request.ResourceChange == nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.changePolicyResource(actor.ProfileID, request.Action, *request.ResourceChange); err != nil {
				return PolicyDraft{}, err
			}
			state.refreshAdmissions()
		default:
			if request.RoleUpdate != nil || request.DeviceChange != nil || request.ResourceChange != nil {
				return PolicyDraft{}, InvalidAction
			}
			if err := state.changeRecipientKey(actor, request.Action, request.PublicKey); err != nil {
				return PolicyDraft{}, err
			}
		}
		draft.Revision++
	}
	digest, err := state.PolicyDigest()
	if err != nil {
		return PolicyDraft{}, err
	}
	draft.ResultDigest = digest
	if draft.TextProjectionVersion < head.Draft.TextProjectionVersion {
		return PolicyDraft{}, ErrPolicySignatureRequired
	}
	if draft.TextProjectionSeed != "" {
		if draft.TextProjectionSeed == head.Draft.TextProjectionSeed {
			return PolicyDraft{}, InvalidPolicy
		}
		draft.TextProjectionRoot, err = state.textProjectionRoot(draft.TextProjectionSeed, draft.TextProjectionVersion)
	} else if head.Draft.TextProjectionRoot != "" || draft.TextProjectionVersion != 0 {
		err = ErrPolicySignatureRequired
	}
	return draft, err
}

func (s *State) changePolicyResource(actor, action string, change PolicyResourceChange) error {
	if change.Admission != nil || change.Departure != nil || change.Recovery != nil || change.RecoveryConfirmation != nil || change.RecoveryDevice != nil ||
		change.DeviceBinding != nil || change.OwnershipTransfer != nil || change.ProfileLink != nil || change.ProfileUnlink != nil ||
		change.ScopeDeviceHandover != nil || change.SettingsEdit != nil || change.ACLRoleEdit != nil || change.ACLPersonalEdit != nil {
		return InvalidAction
	}
	voiceRestriction := action == ChangeVoiceMute || action == ChangeVoiceDeafen
	ordering := action == OrderPolicyChannel || action == OrderPolicyCategory
	copying := action == CopyPolicyChannel || action == CopyPolicyCategory
	if (action == CreatePolicyChannel) != (change.Channel != nil) ||
		(action == EditPolicyChannel) != (change.Settings != nil) ||
		copying != (change.SourceID != "") ||
		voiceRestriction != (change.TargetProfileID != "") || (change.Lift && !voiceRestriction) ||
		(change.VoiceTargetSessionID != "" && (!voiceRestriction || !validRotationID(change.VoiceTargetSessionID))) ||
		(change.Name != "" && action != CreatePolicyCategory && action != RenamePolicyCategory && action != CopyPolicyCategory) ||
		ordering != (change.AnchorID != "") || (change.After && !ordering) || (change.MixedOrder && action != OrderPolicyChannel) {
		return InvalidAction
	}
	if action == CreatePolicyChannel {
		if change.Mode != "" {
			return InvalidAction
		}
		return s.createChannel(actor, change.ID, change.CategoryID, *change.Channel, change.ACL)
	}
	if action == MovePolicyChannel {
		if change.ACL != nil {
			return InvalidAction
		}
		return s.moveChannel(actor, change.ID, change.CategoryID, change.Mode)
	}
	mediaOnly := action == ChangeVoiceDeafen && change.Mode == "server-media"
	serverVoice := voiceRestriction && (change.Mode == "server" || mediaOnly) && change.VoiceTargetSessionID != ""
	if change.CategoryID != "" || (action != DeletePolicyCategory && change.Mode != "" && !serverVoice) {
		return InvalidAction
	}
	switch action {
	case UpdateChannelACL, UpdateCategoryACL:
		if change.ACL == nil {
			return InvalidAction
		}
		if action == UpdateChannelACL {
			return s.setChannelACL(actor, change.ID, *change.ACL)
		}
		return s.setCategoryACL(actor, change.ID, *change.ACL)
	default:
		if change.ACL != nil {
			return InvalidAction
		}
	}
	switch action {
	case ChangeVoiceMute, ChangeVoiceDeafen:
		return s.changeVoiceRestriction(actor, change.ID, change.TargetProfileID, action, change.Lift, serverVoice, mediaOnly, change.VoiceTargetSessionID != "")
	case SyncChannelACL:
		return s.syncChannelACL(actor, change.ID)
	case EditPolicyChannel:
		return s.editChannel(actor, change.ID, *change.Settings)
	case CopyPolicyChannel:
		return s.copyChannel(actor, change.ID, change.SourceID)
	case CopyPolicyCategory:
		return s.copyCategory(actor, change.ID, change.SourceID, change.Name)
	case OrderPolicyChannel:
		return s.reorderChannel(actor, change.ID, change.AnchorID, change.After, change.MixedOrder)
	case OrderPolicyCategory:
		return s.reorderCategory(actor, change.ID, change.AnchorID, change.After)
	case DeletePolicyChannel:
		return s.deleteChannel(actor, change.ID)
	case CreatePolicyCategory:
		if change.Name != "" && !validResourceName(change.Name) {
			return InvalidPolicy
		}
		if err := s.createCategory(actor, change.ID); err != nil {
			return err
		}
		if change.Name != "" {
			s.setCategoryName(change.ID, change.Name)
		}
		return nil
	case RenamePolicyCategory:
		return s.renameCategory(actor, change.ID, change.Name)
	case DeletePolicyCategory:
		if change.Mode != KeepChildren && change.Mode != DeleteChildren {
			return InvalidAction
		}
		return s.deleteCategory(actor, change.ID, change.Mode == DeleteChildren)
	}
	return InvalidAction
}

func (s *State) changePolicyDevice(actor Principal, action string, change PolicyDeviceChange) error {
	if !isDigest(change.DeviceID) {
		return InvalidAction
	}
	entry, exists := s.PolicyDevices[change.DeviceID]
	if action == EnrollPolicyDevice {
		if exists || !signingKeyMatches(change.DeviceID, change.PublicKey) ||
			(len(change.Consent) != 0 && len(change.Consent) != 64) {
			return InvalidAction
		}
		s.PolicyDevices[change.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: change.PublicKey}
		return nil
	}
	if !exists || entry.Revoked || entry.ProfileID != actor.ProfileID || change.PublicKey != "" || len(change.Consent) != 0 {
		return InvalidAction
	}
	entry.Revoked = true
	s.PolicyDevices[change.DeviceID] = entry
	if _, hasRecipient := s.KeyRecipients[change.DeviceID]; hasRecipient {
		return s.changeRecipientKey(Principal{ProfileID: actor.ProfileID, DeviceID: change.DeviceID}, RevokeRecipientKey, "")
	}
	return nil
}

func (s *State) changeRecipientKey(actor Principal, action, key string) error {
	switch action {
	case EnrollRecipientKey:
		if _, exists := s.KeyRecipients[actor.DeviceID]; exists || !validRecipientKey(key) || s.RetiredRecipientKeys[key] {
			return ErrRecipientKey
		}
		if s.KeyRecipients == nil {
			s.KeyRecipients = make(map[string]KeyRecipient)
		}
		s.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: key}
	case RevokeRecipientKey:
		target, exists := s.KeyRecipients[actor.DeviceID]
		if key != "" || !exists || target.ProfileID != actor.ProfileID || target.Kind != "device" {
			return ErrRecipientKey
		}
		delete(s.KeyRecipients, actor.DeviceID)
		if s.RetiredRecipientKeys == nil {
			s.RetiredRecipientKeys = make(map[string]bool)
		}
		s.RetiredRecipientKeys[target.PublicKey] = true
	default:
		return InvalidAction
	}
	if !s.validState() {
		return ErrRecipientKey
	}
	return nil
}

func validRecipientKey(key string) bool {
	if !isDigest(key) {
		return false
	}
	raw, _ := hex.DecodeString(key)
	// RFC 7748 decoders accept aliases, while the policy tracks key identity
	// by bytes. Reject aliases before checking whether a key was retired.
	if raw[31] >= 0x80 || raw[31] == 0x7f && raw[0] >= 0xed &&
		bytes.Equal(raw[1:31], bytes.Repeat([]byte{0xff}, 30)) {
		return false
	}
	curve := ecdh.X25519()
	public, err := curve.NewPublicKey(raw)
	if err != nil {
		return false
	}
	// X25519 rejects low-order inputs when computing a shared secret.
	// This probe key is public and is used only for point validation.
	probe, err := curve.NewPrivateKey(make([]byte, 32))
	if err != nil {
		return false
	}
	_, err = probe.ECDH(public)
	return err == nil
}

func (s *Store) PreviewPolicy(ctx context.Context, resolve ResolveSession, request PolicyDraft) (PolicyDraft, error) {
	preview, err := s.previewPolicy(ctx, resolve, request, 0)
	return preview.Draft, err
}

func (s *Store) PreviewPolicyForTransport(ctx context.Context, resolve ResolveSession, request PolicyDraft) (PolicyPreview, error) {
	return s.previewPolicy(ctx, resolve, request, ChannelSettingsProjectionVersion)
}

func (s *Store) PreviewACLPolicyForTransport(ctx context.Context, resolve ResolveSession, request PolicyDraft, projectionVersion int) (PolicyPreview, error) {
	if projectionVersion < ChannelACLProjectionVersion || !HasTextRecipientProjection(projectionVersion) {
		return PolicyPreview{}, InvalidAction
	}
	return s.previewPolicy(ctx, resolve, request, projectionVersion)
}

func (s *Store) previewPolicy(ctx context.Context, resolve ResolveSession, request PolicyDraft, projectionVersion int) (PolicyPreview, error) {
	var result PolicyPreview
	wire := projectionVersion != 0
	if request.Action == BindPolicyDevice || request.Action == TransferPolicyOwnership || request.Action == MoveScopeDevice ||
		request.Action == EditScopedChannelSettings || request.Action == EditScopedChannelACLRoleRules || request.Action == EditScopedChannelACLPersonal || request.Action == EditScopedRoles ||
		isProfileLinkingAction(request.Action) || isRecoveryPolicyAction(request.Action) ||
		wire && (request.TextProjectionSeed != "" || request.TextProjectionRoot != "" || request.TextProjectionVersion != 0) {
		return result, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return result, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return result, err
	}
	if request.Action == UpdatePolicyRoles && !state.canInspectFullPolicy(actor) {
		return result, MissingGrant
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return result, err
	}
	discloseFullPolicy := actor.ProfileID == state.Owner || state.canInspectFullPolicy(actor)
	if err := validateVoiceRestrictionTargetSession(ctx, tx, state, actor, request, s.now().UnixMilli()); err != nil {
		return result, err
	}
	if wire && request.Action == OrderPolicyChannel && request.ResourceChange != nil && head.Draft.TextProjectionVersion >= TextOrderAuthorityVersion {
		layout := state
		result.ChannelOrderBasis, err = channelLayoutBasis(ctx, tx, &layout, actor.ProfileID, *request.ResourceChange, head.Draft.TextProjectionSeed)
		if err != nil {
			return result, err
		}
		result.ChannelOrderBasisVersion = 2
		if request.ResourceChange.MixedOrder {
			result.ChannelOrderBasisVersion = 3
		}
	}
	if request.TextProjectionSeed == "" && (wire || head.Draft.TextProjectionRoot != "") {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			return result, err
		}
		request.TextProjectionSeed = hex.EncodeToString(seed[:])
	}
	if wire {
		request.TextProjectionVersion = max(projectionVersion, head.Draft.TextProjectionVersion)
	} else if request.TextProjectionVersion == 0 {
		request.TextProjectionVersion = head.Draft.TextProjectionVersion
	}
	result.Draft, err = preparePolicyDraft(&state, revision, head, actor, request)
	if err != nil || !wire {
		return result, err
	}
	result.RoleUpdate, err = json.Marshal(result.Draft.RoleUpdate)
	if err != nil {
		return result, err
	}
	if result.Draft.ResourceChange != nil {
		result.ResourceChange, err = json.Marshal(result.Draft.ResourceChange)
		if err != nil {
			return result, err
		}
	}
	if discloseFullPolicy {
		result.Snapshot, err = state.policySnapshotBytes()
		if len(result.Snapshot)+len(result.RoleUpdate)+len(result.ResourceChange) > 8<<20 {
			return PolicyPreview{}, InvalidPolicy
		}
	} else {
		result.Draft.TextProjectionSeed = ""
		result.Draft.TextProjectionRoot = ""
		result.Draft.TextProjectionVersion = 0
	}
	return result, err
}

func (s *Store) CommitPolicy(ctx context.Context, resolve ResolveSession, verify VerifyPolicyDraft, input PolicyDraft) (PolicyProof, error) {
	if input.Action == BindPolicyDevice || input.Action == TransferPolicyOwnership || input.Action == MoveScopeDevice ||
		input.Action == EditScopedChannelSettings || input.Action == EditScopedChannelACLRoleRules || input.Action == EditScopedChannelACLPersonal || input.Action == EditScopedRoles || isProfileLinkingAction(input.Action) ||
		input.Action == RedeemPolicyInvite || IsMemberDepartureAction(input.Action) || isRecoveryPolicyAction(input.Action) {
		return PolicyProof{}, InvalidAction
	}
	return s.commitPolicy(ctx, resolve, verify, input, nil, nil, nil)
}

func (s *Store) CommitInviteAdmissionPolicy(ctx context.Context, resolve ResolveSession, verify VerifyPolicyDraft, input PolicyDraft,
	confirm ConfirmInviteAdmission) (PolicyProof, error) {
	if input.Action != AdmitInviteMember || confirm == nil {
		return PolicyProof{}, InvalidAction
	}
	return s.commitPolicy(ctx, resolve, verify, input, confirm, nil, nil)
}

// CommitPolicyWithScopeAttestation binds the owner attestation to exactly the
// proof accepted in the same transaction, including on idempotent retries.
func (s *Store) CommitPolicyWithScopeAttestation(ctx context.Context, resolve ResolveSession, verify VerifyPolicyDraft,
	input PolicyDraft, confirm ConfirmInviteAdmission, signature []byte, verifyScope VerifyPolicyAttestation) (PolicyProof, error) {
	if input.Action == BindPolicyDevice || input.Action == TransferPolicyOwnership || input.Action == MoveScopeDevice ||
		input.Action == EditScopedChannelSettings || input.Action == EditScopedChannelACLRoleRules || input.Action == EditScopedChannelACLPersonal || input.Action == EditScopedRoles || isProfileLinkingAction(input.Action) ||
		input.Action == RedeemPolicyInvite || IsMemberDepartureAction(input.Action) || isRecoveryPolicyAction(input.Action) ||
		len(signature) != 64 || verifyScope == nil {
		return PolicyProof{}, InvalidAction
	}
	return s.commitPolicy(ctx, resolve, verify, input, confirm, signature, verifyScope)
}

func (s *Store) commitPolicy(ctx context.Context, resolve ResolveSession, verify VerifyPolicyDraft, input PolicyDraft,
	confirm ConfirmInviteAdmission, signature []byte, verifyScope VerifyPolicyAttestation) (PolicyProof, error) {
	var proof PolicyProof
	if verify == nil || len(input.Signature) != 64 {
		return proof, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return proof, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return proof, err
	}
	if input.Action == AdmitInviteMember {
		if confirm == nil || input.ResourceChange == nil || input.ResourceChange.Admission == nil {
			return proof, InvalidAction
		}
	}
	if verifyScope != nil {
		proof, err = readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx,
			"SELECT revision,operation_id,digest,record FROM protected_policy_proofs WHERE operation_id=?", input.OperationID))
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return PolicyProof{}, err
		case proof.Principal != actor || !reflect.DeepEqual(proof.Draft, input):
			return PolicyProof{}, ErrPolicyConflict
		default:
			if err := verify(ctx, tx, proof.Principal, proof.Draft); err != nil {
				return PolicyProof{}, err
			}
		}
	}
	if proof.Digest == "" {
		proof, err = s.commitPolicyInTransaction(ctx, tx, actor, verify, input, confirm)
		if err != nil {
			return PolicyProof{}, err
		}
	}
	if verifyScope != nil {
		if err := storePolicyAttestation(ctx, tx, verifyScope, actor, proof.Draft.Revision, signature); err != nil {
			return PolicyProof{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return PolicyProof{}, err
	}
	return proof, nil
}

func PreviewInitialPolicy(initial State, actor Principal, operationID, textProjectionSeed string, textProjectionVersion int) (PolicyDraft, []byte, error) {
	initial, err := normalizeInitialState(initial)
	if err != nil {
		return PolicyDraft{}, nil, err
	}
	draft, err := preparePolicyDraft(&initial, 1, PolicyProof{}, actor, PolicyDraft{
		Action: AnchorPolicy, OperationID: operationID, TextProjectionSeed: textProjectionSeed, TextProjectionVersion: textProjectionVersion,
	})
	if err != nil {
		return PolicyDraft{}, nil, err
	}
	snapshot, err := initial.policySnapshotBytes()
	return draft, snapshot, err
}

// InstallSignedInitialPolicy installs policy, routing tasks and genesis proof
// atomically with the caller's migration state.
func (s *Store) InstallSignedInitialPolicy(ctx context.Context, tx *sql.Tx, initial State, actor Principal,
	verify VerifyPolicyDraft, draft PolicyDraft) (PolicyProof, error) {
	if draft.Action != AnchorPolicy || verify == nil || len(draft.Signature) != 64 {
		return PolicyProof{}, InvalidAction
	}
	if err := s.InitializeInTransaction(ctx, tx, initial); err != nil {
		return PolicyProof{}, err
	}
	return s.commitPolicyInTransaction(ctx, tx, actor, verify, draft, nil)
}

func (s *Store) commitPolicyInTransaction(ctx context.Context, tx *sql.Tx, actor Principal, verify VerifyPolicyDraft, input PolicyDraft,
	confirm ConfirmInviteAdmission) (PolicyProof, error) {
	var proof PolicyProof
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return proof, err
	}
	if input.Action == UpdatePolicyRoles && !state.canInspectFullPolicy(actor) {
		return proof, MissingGrant
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return proof, err
	}
	if head.Digest != "" {
		if err := verify(ctx, tx, head.Principal, head.Draft); err != nil {
			return proof, err
		}
	}
	if err := validateVoiceRestrictionTargetSession(ctx, tx, state, actor, input, s.now().UnixMilli()); err != nil {
		return proof, err
	}
	recipients := state.recipients()
	beforeRoles := state.RoleSnapshot
	var deletedResourceName string
	if input.ResourceChange != nil {
		id := input.ResourceChange.ID
		switch input.Action {
		case DeletePolicyChannel:
			if settings := state.Channels[id].Settings; settings != nil {
				deletedResourceName = settings.Name
			}
		case DeletePolicyCategory:
			deletedResourceName = state.CategoryNames[id]
		}
	}
	revokesRecipient := input.Action == RevokeRecipientKey || input.Action == RecoverPolicyDevice
	if input.Action == RevokePolicyDevice && input.DeviceChange != nil {
		_, revokesRecipient = state.KeyRecipients[input.DeviceChange.DeviceID]
	}
	var replacesRecovery bool
	if input.Action == EnrollPolicyRecovery {
		for _, recipient := range state.KeyRecipients {
			if recipient.ProfileID == actor.ProfileID && recipient.Kind == "recovery" {
				replacesRecovery = true
				break
			}
		}
	}
	expected, err := preparePolicyDraft(&state, revision, head, actor, input)
	if err != nil {
		return proof, err
	}
	if input.Revision != expected.Revision || input.PreviousDigest != expected.PreviousDigest || input.ResultDigest != expected.ResultDigest ||
		input.TextProjectionRoot != expected.TextProjectionRoot {
		return proof, ErrPolicyConflict
	}
	if err := verify(ctx, tx, actor, input); err != nil {
		return proof, err
	}
	if confirm != nil {
		if err := confirm(ctx, tx, *input.ResourceChange.Admission); err != nil {
			return proof, err
		}
	}
	proof = PolicyProof{Principal: actor, Draft: input}
	raw, err := json.Marshal(proof)
	if err != nil {
		return PolicyProof{}, err
	}
	// A proof identity follows its signature, independently of JSON formatting.
	hash := sha256.Sum256(input.Signature)
	proof.Digest = hex.EncodeToString(hash[:])
	signedSnapshot, err := state.policySnapshotBytes()
	if err != nil {
		return PolicyProof{}, err
	}
	insert, err := tx.ExecContext(ctx, `INSERT INTO protected_policy_proofs (revision,operation_id,digest,snapshot,record)
	    VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`, input.Revision, input.OperationID, proof.Digest, signedSnapshot, raw)
	if err != nil {
		return PolicyProof{}, err
	}
	count, err := insert.RowsAffected()
	if err != nil {
		return PolicyProof{}, err
	}
	if count != 1 {
		return PolicyProof{}, ErrPolicyConflict
	}
	if input.Action == AnchorPolicy {
		state.PolicyAnchored = true
		snapshot, err := json.Marshal(state)
		if err != nil {
			return PolicyProof{}, err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", snapshot); err != nil {
			return PolicyProof{}, err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE protected_rotation_tasks SET lease_device='',lease_id='',lease_until=0,archive_through=0"); err != nil {
			return PolicyProof{}, err
		}
	} else {
		keyChanges := make(map[string]bool)
		if isProfileLinkingAction(input.Action) {
			state.revokeProfileLinkEpochWindows(recipients, keyChanges, s.now().UnixMilli(), actor, input.Action, input.ResourceChange)
		}
		if input.Action == EnrollRecipientKey || input.Action == EnrollPolicyRecovery || revokesRecipient {
			now := s.now().UnixMilli()
			for channelID, readers := range recipients {
				if _, canRead := readers[actor.ProfileID]; canRead {
					keyChanges[channelID] = true
					if window, exists := state.EpochWindows[channelID]; exists && (revokesRecipient || replacesRecovery) {
						state.EpochWindows[channelID] = window.Revoke(now)
					}
				}
			}
		}
		initiator := actor.ProfileID
		if input.Action == EnrollRecipientKey || input.Action == RedeemPolicyInvite || input.Action == RecoverPolicyDevice ||
			input.Action == UnlinkPolicyProfile || IsMemberDepartureAction(input.Action) {
			// The enrolling device has no old epoch package to rotate from.
			initiator = ""
		}
		if err := s.persistChange(ctx, tx, state, revision, initiator, recipients, keyChanges); err != nil {
			return PolicyProof{}, err
		}
	}
	if input.Action == BindPolicyDevice {
		if err := queueDeviceBindingRotations(ctx, tx, recipients, actor.ProfileID, revision+1, s.now().UnixMilli()); err != nil {
			return PolicyProof{}, err
		}
	}
	if err := recordPolicyAudit(ctx, tx, s.now().UnixMilli(), actor, input, beforeRoles, state.RoleSnapshot, replacesRecovery, deletedResourceName); err != nil {
		return PolicyProof{}, err
	}
	if input.Action == OrderPolicyChannel {
		layout := state
		present, err := applyChannelLayout(ctx, tx, &layout)
		if err != nil {
			return PolicyProof{}, err
		}
		if present {
			change := input.ResourceChange
			if err := layout.reorderChannel(actor.ProfileID, change.ID, change.AnchorID, change.After, change.MixedOrder); err != nil {
				return PolicyProof{}, err
			}
			if err := saveChannelLayout(ctx, tx, layout); err != nil {
				return PolicyProof{}, err
			}
		}
	}
	return proof, nil
}

// ReadPolicyHead verifies the stored proof commitment and its match to the
// applied snapshot. Supplying an actor also checks its device enrollment.
// The caller still verifies the signature.
func ReadPolicyHead(ctx context.Context, query SessionQuery, actor *Principal) (PolicyProof, error) {
	state, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return PolicyProof{}, err
	}
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return PolicyProof{}, err
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return PolicyProof{}, err
	}
	if actor != nil && state.PolicyAnchored && !state.hasPolicyDevice(*actor) {
		return PolicyProof{}, Inactive
	}
	return head, nil
}

// ReadDeviceDeparture returns the policy head for a revoked device or a
// device separated from the active profile by an explicit profile unlink.
func ReadDeviceDeparture(ctx context.Context, query SessionQuery, deviceID string) (PolicyProof, bool, error) {
	state, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return PolicyProof{}, false, err
	}
	device := state.PolicyDevices[deviceID]
	detached := device.ProfileID != "" && state.DetachedPolicyDevices[deviceID] == device.ProfileID
	if !state.PolicyAnchored || !device.Revoked || (!detached && !state.Members[device.ProfileID].Active) {
		return PolicyProof{}, false, nil
	}
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return PolicyProof{}, false, err
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return PolicyProof{}, false, err
	}
	return head, detached, nil
}
