package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

const profileAvatarSchema = `
CREATE TABLE IF NOT EXISTS protected_profile_avatars (
	profile_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=2),
	receipt TEXT NOT NULL, body BLOB
) STRICT;
CREATE TABLE IF NOT EXISTS protected_profile_avatar_packages (
	profile_id TEXT NOT NULL, device_id TEXT NOT NULL, agreement_key TEXT NOT NULL,
	ciphertext BLOB NOT NULL CHECK(length(ciphertext)=80),
	PRIMARY KEY(profile_id,device_id)
) STRICT;`

type ProfileAvatarView struct {
	CommunityAvatarView
	NeedsDelivery bool `json:"needsDelivery,omitempty"`
}

func profileAvatarRecipients(state State, profileID, sharing string) []string {
	shared := profileID == state.Owner && sharing == "1" || sharing == "members" &&
		state.CheckGrant(state.Members[profileID], Scope{}, "member.list", 0) == Allowed
	recipients := communityAvatarRecipientIDs(state)
	result := recipients[:0]
	for _, id := range recipients {
		key := state.KeyRecipients[id]
		if key.Kind == "device" && (key.ProfileID == profileID || shared) {
			result = append(result, id)
		}
	}
	return result
}

func (s *Store) DispatchOwnProfileAvatar(ctx context.Context, resolve ResolveSession, sharing string, deliver func(ProfileAvatarView) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canReadCommunityAvatar(actor) {
			return ChannelRestricted
		}
		result, err := loadProfileAvatar(ctx, conn, state, actor, actor.ProfileID)
		if err != nil {
			return err
		}
		if result.Content == nil {
			return deliver(result)
		}
		rows, err := conn.QueryContext(ctx, "SELECT device_id,agreement_key FROM protected_profile_avatar_packages WHERE profile_id=?", actor.ProfileID)
		if err != nil {
			return err
		}
		defer rows.Close()
		covered := make(map[string]string)
		for rows.Next() {
			var id, key string
			if err := rows.Scan(&id, &key); err != nil {
				return err
			}
			covered[id] = key
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range profileAvatarRecipients(state, actor.ProfileID, sharing) {
			if covered[id] != state.KeyRecipients[id].PublicKey {
				result.NeedsDelivery = true
				break
			}
		}
		return deliver(result)
	})
}

func loadProfileAvatar(ctx context.Context, conn *sql.Conn, state State, actor Principal, profileID string) (ProfileAvatarView, error) {
	result := ProfileAvatarView{CommunityAvatarView: CommunityAvatarView{Revision: 1}}
	var body, packet []byte
	err := conn.QueryRowContext(ctx, `SELECT a.revision,a.body,p.ciphertext FROM protected_profile_avatars a
			LEFT JOIN protected_profile_avatar_packages p ON p.profile_id=a.profile_id AND p.device_id=? AND p.agreement_key=?
			WHERE a.profile_id=?`, actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey, profileID).
		Scan(&result.Revision, &body, &packet)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if len(body) == 0 || len(packet) == 0 {
		result.Pending = len(body) != 0
		return result, nil
	}
	var content CommunityAvatarContent
	if err := json.Unmarshal(body, &content); err != nil || content.Context.Scope != "profile" || content.Context.ProfileID != profileID {
		return result, ErrPolicyConflict
	}
	publisher, err := readCommunityAvatarPublisher(ctx, conn, content)
	if err != nil {
		return result, err
	}
	result.Content, result.Publisher = &content, &publisher
	result.Package = &CommunityAvatarPackage{ID: actor.DeviceID, Ciphertext: packet}
	return result, nil
}

func (s *Store) SaveOwnProfileAvatar(ctx context.Context, resolve ResolveSession, input CommunityAvatarUpdate, sharing string) (int64, error) {
	binding := input.Context
	if binding.Scope != "profile" || binding.Revision < 2 || binding.Revision > 1<<53-1 || !validRotationID(binding.Operation) ||
		len(input.Packages) > 8192 || input.Packet == nil && len(input.Packages) != 0 {
		return 0, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return 0, err
	}
	state, policyRevision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return 0, err
	}
	if !state.canReadCommunityAvatar(actor) || binding.DeviceID != actor.DeviceID || binding.ProfileID != actor.ProfileID {
		return 0, ChannelRestricted
	}
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return 0, err
	}
	if serverID != binding.ServerID {
		return 0, InvalidAction
	}
	revision, receipt := int64(1), ""
	if err := tx.QueryRowContext(ctx, "SELECT revision,receipt FROM protected_profile_avatars WHERE profile_id=?", actor.ProfileID).
		Scan(&revision, &receipt); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return 0, err
	}
	digest := hexHash(raw)
	if revision == binding.Revision && receipt == digest {
		return revision, nil
	}
	if revision+1 != binding.Revision {
		return 0, ErrCommunityAvatarChanged
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return 0, err
	}
	if err := checkPolicyHead(state, policyRevision, head); err != nil {
		return 0, err
	}
	if binding.PolicyHead != head.Digest {
		return 0, ErrPolicyConflict
	}
	var body []byte
	if input.Packet != nil {
		if head.Draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion {
			return 0, ErrPolicyAttestationUnavailable
		}
		if err := input.Packet.Verify(binding, state.PolicyDevices[actor.DeviceID].PublicKey); err != nil {
			return 0, err
		}
		recipients := profileAvatarRecipients(state, actor.ProfileID, sharing)
		if len(recipients) == 0 || len(recipients) != len(input.Packages) {
			return 0, ErrEpochRecipients
		}
		for i, packet := range input.Packages {
			if packet.ID != recipients[i] || len(packet.Ciphertext) != EpochPackageSize {
				return 0, ErrEpochRecipients
			}
		}
		body, err = json.Marshal(CommunityAvatarContent{Context: binding, Packet: *input.Packet, PolicyRevision: policyRevision})
		if err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_profile_avatar_packages WHERE profile_id=?", actor.ProfileID); err != nil {
		return 0, err
	}
	for _, packet := range input.Packages {
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_profile_avatar_packages
			(profile_id,device_id,agreement_key,ciphertext) VALUES (?,?,?,?)`,
			actor.ProfileID, packet.ID, state.KeyRecipients[packet.ID].PublicKey, packet.Ciphertext); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_profile_avatars(profile_id,revision,receipt,body) VALUES (?,?,?,?)
		ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,receipt=excluded.receipt,body=excluded.body`,
		actor.ProfileID, binding.Revision, digest, body); err != nil {
		return 0, err
	}
	return binding.Revision, tx.Commit()
}
