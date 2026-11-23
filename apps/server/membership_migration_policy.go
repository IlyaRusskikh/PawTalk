package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"slices"
	"time"

	"pawtalk/server/internal/access"
)

type migrationPolicyBlocker struct {
	Code      string `json:"code"`
	RoleID    string `json:"roleId,omitempty"`
	ProfileID string `json:"profileId,omitempty"`
	ChannelID string `json:"channelId,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

type migrationRoleMetadata struct {
	Name       string   `json:"name"`
	LegacyRank int      `json:"legacyRank"`
	Legacy     []string `json:"legacyPermissions"`
}

type migrationChannelMetadata struct {
	Name          string `json:"name"`
	Position      int    `json:"position"`
	ProtectedKind string `json:"protectedKind,omitempty"`
}

type migrationRecoveryArchiveCoverage struct {
	StagedKeys        int64 `json:"stagedKeys"`
	ConfirmedPackages int64 `json:"confirmedPackages"`
}

type migrationPolicyDraft struct {
	OwnerProfileID        string                              `json:"ownerProfileId"`
	OwnerRecoveryRequired bool                                `json:"ownerRecoveryRequired"`
	OwnerRecovery         *migrationRecoveryEnrollment        `json:"ownerRecovery,omitempty"`
	OwnerRecoveryArchive  migrationRecoveryArchiveCoverage    `json:"ownerRecoveryArchive"`
	State                 *access.State                       `json:"state,omitempty"`
	RoleMetadata          map[string]migrationRoleMetadata    `json:"roleMetadata"`
	ChannelMetadata       map[string]migrationChannelMetadata `json:"channelMetadata"`
	AdministratorPending  []string                            `json:"administratorPending"`
	Blockers              []migrationPolicyBlocker            `json:"blockers"`
}

var migratedLegacyGrants = map[string][]string{
	"chat.read":         {"history.full"},
	"chat.write":        {"message.send", "message.attach", "message.voice", "poll.create", "poll.vote", "checklist.create", "checklist.check"},
	"voice.join":        {"voice.connect", "voice.speak"},
	"invite.create":     {"invite.create"},
	"invite.revoke.own": {}, // Covered by invite.create when both legacy grants are present.
	"invite.revoke.any": {"invite.view-all", "invite.manage-all"},
	"channel.manage":    {"channel.create", "channel.edit", "channel.delete"},
	"role.manage":       {"role.assign"},
	"member.kick":       {"member.kick"},
	"member.ban":        {"member.ban"},
}

// Derive a review draft only. Device signing keys carry existing identity;
// encryption recipients and recovery readiness require new enrollment proofs.
func readMigrationPolicyDraft(ctx context.Context, tx *sql.Tx, authority migrationAuthority) (migrationPolicyDraft, error) {
	draft := migrationPolicyDraft{
		OwnerProfileID: authority.ownerID, OwnerRecoveryRequired: true,
		State: &access.State{RoleSnapshot: access.RoleSnapshot{
			Policy: access.Policy{Owner: authority.ownerID, Roles: map[string]access.Role{
				access.Everyone: {Grants: []string{access.ChannelView, "member.list", "profile.edit-self"}},
			}}, Members: make(map[string]access.Subject),
		}, Channels: make(map[string]access.Channel), PolicyDevices: make(map[string]access.PolicyDevice)},
		RoleMetadata: make(map[string]migrationRoleMetadata), ChannelMetadata: make(map[string]migrationChannelMetadata),
		AdministratorPending: []string{}, Blockers: []migrationPolicyBlocker{},
	}
	if err := draft.readRoles(ctx, tx); err != nil {
		return draft, err
	}
	if err := draft.readChannels(ctx, tx); err != nil {
		return draft, err
	}
	if err := draft.readMembers(ctx, tx); err != nil {
		return draft, err
	}
	importBindings, err := migrationImportsProfileBindings(ctx, tx)
	if err != nil {
		return draft, err
	}
	if importBindings {
		if err := draft.readProfileBindings(ctx, tx); err != nil {
			return draft, err
		}
	}
	if err := draft.readDevices(ctx, tx); err != nil {
		return draft, err
	}
	recovery, err := readMigrationRecoveryEnrollment(ctx, tx, authority.ownerID)
	if err != nil {
		return draft, err
	}
	draft.OwnerRecovery = recovery
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(k.channel_id),COUNT(p.channel_id)
		FROM protected_migration_channel_keys k LEFT JOIN protected_migration_recovery_packages p
		ON p.channel_id=k.channel_id AND p.key_id=k.key_id AND p.recovery_id=(
			SELECT recovery_id FROM protected_migration_owner_recovery WHERE id=1 AND profile_id=?
		)`, authority.ownerID).Scan(&draft.OwnerRecoveryArchive.StagedKeys, &draft.OwnerRecoveryArchive.ConfirmedPackages); err != nil {
		return draft, err
	}
	if len(draft.Blockers) != 0 {
		draft.State = nil
	}
	return draft, nil
}

func (d *migrationPolicyDraft) readRoles(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT r.role_id,r.name,
		CASE r.system_kind WHEN 'admin' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END AS rank,p.permission
		FROM roles r LEFT JOIN role_permissions p USING(role_id)
		ORDER BY rank,r.role_id,p.permission`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		var rank int
		var permission sql.NullString
		if err := rows.Scan(&id, &name, &rank, &permission); err != nil {
			return err
		}
		role, seen := d.RoleMetadata[id]
		if !seen {
			if id == "" || id == access.Everyone {
				return errors.New("legacy role ID collides with protected role policy")
			}
			if order := d.State.Order; len(order) > 0 && d.RoleMetadata[order[len(order)-1]].LegacyRank == rank {
				d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "LEGACY_ROLE_RANK_TIE", RoleID: id, Detail: order[len(order)-1]})
			}
			d.State.Order = append(d.State.Order, id)
			role = migrationRoleMetadata{Name: name, LegacyRank: rank, Legacy: []string{}}
		}
		if permission.Valid {
			role.Legacy = append(role.Legacy, permission.String)
		}
		d.RoleMetadata[id] = role
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range d.State.Order {
		role := d.RoleMetadata[id]
		grants := []string{}
		for _, legacy := range role.Legacy {
			mapped, known := migratedLegacyGrants[legacy]
			if !known {
				d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "UNMAPPED_LEGACY_PERMISSION", RoleID: id, Detail: legacy})
			}
			grants = append(grants, mapped...)
		}
		create, revokeOwn := slices.Contains(role.Legacy, "invite.create"), slices.Contains(role.Legacy, "invite.revoke.own")
		if create != revokeOwn || (slices.Contains(role.Legacy, "invite.revoke.any") && !create) {
			d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "LEGACY_INVITE_GRANTS_SPLIT", RoleID: id})
		}
		if role.LegacyRank == 3 { // API 2 gates server name and avatar on the system rank.
			grants = append(grants, "server.edit")
		}
		slices.Sort(grants)
		d.State.Roles[id] = access.Role{Grants: grants}
	}
	return nil
}

func (d *migrationPolicyDraft) readChannels(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT c.channel_id,c.kind,c.name,c.position,COALESCE(c.protected_kind,''),
		(SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.channel_id)
		FROM channels c ORDER BY c.channel_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var channel access.Channel
		var metadata migrationChannelMetadata
		var messageCount int64
		if err := rows.Scan(&id, &channel.Kind, &metadata.Name, &metadata.Position, &metadata.ProtectedKind, &messageCount); err != nil {
			return err
		}
		if messageCount >= migrationMaxSafePosition {
			d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "MIGRATION_CHANNEL_POSITION_LIMIT", ChannelID: id})
		} else {
			channel.NextPosition = uint64(messageCount) + 1
		}
		d.State.Channels[id], d.ChannelMetadata[id] = channel, metadata
	}
	return rows.Err()
}

func (d *migrationPolicyDraft) readMembers(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT m.profile_id,m.state='active' AND NOT EXISTS(
		SELECT 1 FROM ban_subjects bs JOIN ban_actions ba USING(ban_id)
		WHERE bs.profile_id=m.profile_id AND ba.revoked_at IS NULL AND (ba.expires_at IS NULL OR ba.expires_at>c.started_at)),r.role_id
		FROM memberships m CROSS JOIN protected_migration_source c
		LEFT JOIN effective_profile_roles r USING(profile_id)
		WHERE c.id=1 AND NOT EXISTS(SELECT 1 FROM profile_bindings b WHERE b.source_profile_id=m.profile_id)
		ORDER BY m.profile_id,r.role_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var profiles []string
	for rows.Next() {
		var id string
		var active bool
		var role sql.NullString
		if err := rows.Scan(&id, &active, &role); err != nil {
			return err
		}
		member, seen := d.State.Members[id]
		if !seen {
			profiles = append(profiles, id)
			member = access.Subject{ID: id, Active: active, Roles: []string{}}
		}
		if member.Active && role.Valid {
			member.Roles = append(member.Roles, role.String)
		}
		d.State.Members[id] = member
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range profiles {
		member := d.State.Members[id]
		if !member.Active {
			continue
		}
		legacy := memberAccess{}
		for _, roleID := range member.Roles {
			role := d.RoleMetadata[roleID]
			legacy.Permissions = append(legacy.Permissions, role.Legacy...)
			if role.LegacyRank == 3 {
				legacy.Role = "admin"
			}
		}
		// API 2 exposes the channel list even without chat.read. In the new
		// policy ChannelView also admits text, so this case needs review.
		if !legacy.allows("chat.read") {
			d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "LEGACY_TEXT_METADATA_WITHOUT_READ", ProfileID: id})
		}
		if id != d.State.Owner && migrationAdministrator(legacy) {
			d.AdministratorPending = append(d.AdministratorPending, id)
		}
	}
	return nil
}

func (d *migrationPolicyDraft) readProfileBindings(ctx context.Context, tx *sql.Tx) error {
	d.State.ImportedProfileBindings = true
	rows, err := tx.QueryContext(ctx, `SELECT b.source_profile_id,b.target_profile_id,
		EXISTS(SELECT 1 FROM memberships m WHERE m.profile_id=b.source_profile_id)
		FROM profile_bindings b ORDER BY b.source_profile_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var source, primary string
		var hasMembership bool
		if err := rows.Scan(&source, &primary, &hasMembership); err != nil {
			return err
		}
		if !validHexID(source, 64) || !validHexID(primary, 64) || source == primary || source == d.State.Owner ||
			!hasMembership || d.State.Members[primary].ID != primary {
			d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "INVALID_LEGACY_PROFILE_BINDING", ProfileID: source, Detail: primary})
			continue
		}
		if d.State.ProfileBindings == nil {
			d.State.ProfileBindings = make(map[string]string)
		}
		d.State.ProfileBindings[source] = primary
		// The original profile remains an inactive origin. Its old grants
		// must not become active when the binding is later removed.
		d.State.Members[source] = access.Subject{ID: source, Roles: []string{}}
	}
	return rows.Err()
}

func (d *migrationPolicyDraft) readDevices(ctx context.Context, tx *sql.Tx) error {
	var started int64
	if err := tx.QueryRowContext(ctx, "SELECT started_at FROM protected_migration_source WHERE id=1").Scan(&started); err != nil {
		return err
	}
	store := &membershipStore{now: func() time.Time { return time.UnixMilli(started) }}
	rows, err := tx.QueryContext(ctx, "SELECT device_id,original_profile_id,signing_public_key FROM devices ORDER BY device_id")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var identity memberIdentity
		var key []byte
		if err := rows.Scan(&identity.DeviceID, &identity.ProfileID, &key); err != nil {
			return err
		}
		resolved, err := store.resolveIdentity(ctx, tx, identity)
		var denied *membershipError
		if errors.As(err, &denied) {
			continue
		}
		if err != nil {
			return err
		}
		if len(key) != 32 || publicKeyID(key) != identity.DeviceID {
			return errors.New("invalid legacy device signing identity")
		}
		d.State.PolicyDevices[identity.DeviceID] = access.PolicyDevice{ProfileID: resolved.EffectiveProfileID, PublicKey: hex.EncodeToString(key)}
		if d.State.ImportedProfileBindings && resolved.EffectiveProfileID != identity.ProfileID {
			if d.State.ProfileBindings[identity.ProfileID] != resolved.EffectiveProfileID {
				d.Blockers = append(d.Blockers, migrationPolicyBlocker{Code: "INVALID_LEGACY_PROFILE_BINDING", ProfileID: identity.ProfileID,
					Detail: resolved.EffectiveProfileID})
				continue
			}
			if d.State.ProfileDeviceOrigins == nil {
				d.State.ProfileDeviceOrigins = make(map[string]string)
			}
			d.State.ProfileDeviceOrigins[identity.DeviceID] = identity.ProfileID
		}
	}
	return rows.Err()
}
