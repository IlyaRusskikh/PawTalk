package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

const communityAvatarSchema = `CREATE TABLE IF NOT EXISTS protected_community_avatar (
	id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=1),
	receipt TEXT NOT NULL, body BLOB
) STRICT;
INSERT OR IGNORE INTO protected_community_avatar (id,revision,receipt) VALUES (1,1,'');
CREATE TABLE IF NOT EXISTS protected_community_avatar_packages (
	device_id TEXT PRIMARY KEY CHECK(length(device_id)=64), ciphertext BLOB NOT NULL CHECK(length(ciphertext)=80),
	agreement_key TEXT NOT NULL CHECK(length(agreement_key)=64)
) STRICT;`

var ErrCommunityAvatarChanged = errors.New("protected community avatar changed")

type CommunityAvatarPackage struct {
	ID         string `json:"id"`
	Ciphertext []byte `json:"ciphertext"`
}

type CommunityAvatarUpdate struct {
	Context  CommunityAvatarContext   `json:"context"`
	Packet   *CommunityAvatarPacket   `json:"packet"`
	Packages []CommunityAvatarPackage `json:"packages,omitempty"`
}

type CommunityAvatarContent struct {
	Context        CommunityAvatarContext `json:"context"`
	Packet         CommunityAvatarPacket  `json:"packet"`
	PolicyRevision int64                  `json:"policyRevision"`
}

type CommunityAvatarView struct {
	Revision  int64                     `json:"revision"`
	Pending   bool                      `json:"pending,omitempty"`
	Content   *CommunityAvatarContent   `json:"content,omitempty"`
	Package   *CommunityAvatarPackage   `json:"package,omitempty"`
	Publisher *CommunityAvatarPublisher `json:"publisher,omitempty"`
}

type LegacyCommunityAvatar struct {
	Envelope []byte `json:"envelope,omitempty"`
	Author   string `json:"author,omitempty"`
}

func EnsureCommunityAvatarSchema(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, communityAvatarSchema+profileAvatarSchema); err != nil {
		return err
	}
	var hasKey bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pragma_table_info('protected_community_avatar_packages')
		WHERE name='agreement_key')`).Scan(&hasKey); err != nil || hasKey {
		return err
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE protected_community_avatar_packages
		ADD COLUMN agreement_key TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE protected_community_avatar_packages AS p SET agreement_key=COALESCE((
		SELECT json_extract(CAST(proof.snapshot AS TEXT),'$.KeyRecipients."' || p.device_id || '".PublicKey')
		FROM protected_community_avatar a JOIN protected_policy_proofs proof
		ON proof.digest=json_extract(CAST(a.body AS TEXT),'$.context.policyHead') WHERE a.id=1
	), '')`)
	return err
}

func (s State) canReadCommunityAvatar(actor Principal) bool {
	return s.PolicyAnchored && s.hasPolicyDevice(actor) && s.canUseDevice(actor) && s.Members[actor.ProfileID].Active
}

func (s *Store) DispatchLegacyCommunityAvatar(ctx context.Context, resolve ResolveSession,
	deliver func(LegacyCommunityAvatar) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canReadCommunityAvatar(actor) || state.Owner != actor.ProfileID {
			return ChannelRestricted
		}
		var avatar LegacyCommunityAvatar
		err := conn.QueryRowContext(ctx, `SELECT old.envelope,old.author_profile_id
			FROM server_avatar old JOIN protected_community_avatar current ON current.id=old.id
			WHERE old.id=1 AND current.revision=1 AND old.envelope IS NOT NULL`).Scan(&avatar.Envelope, &avatar.Author)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return deliver(avatar)
	})
}

func (s *Store) DispatchCommunityAvatar(ctx context.Context, resolve ResolveSession, deliver func(CommunityAvatarView) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canReadCommunityAvatar(actor) {
			return ChannelRestricted
		}
		view, err := readCommunityAvatarView(ctx, conn, actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey)
		if err != nil {
			return err
		}
		return deliver(view)
	})
}

func readCommunityAvatarView(ctx context.Context, query SessionQuery, recipientID, agreementKey string) (CommunityAvatarView, error) {
	var view CommunityAvatarView
	var body, wrapped []byte
	err := query.QueryRowContext(ctx, `SELECT a.revision,a.body,p.ciphertext FROM protected_community_avatar a
		LEFT JOIN protected_community_avatar_packages p ON p.device_id=? AND p.agreement_key=? WHERE a.id=1`, recipientID, agreementKey).
		Scan(&view.Revision, &body, &wrapped)
	if err != nil || body == nil {
		return view, err
	}
	if wrapped == nil {
		view.Pending = true
		return view, nil
	}
	if err := json.Unmarshal(body, &view.Content); err != nil {
		return CommunityAvatarView{}, err
	}
	if view.Content == nil || view.Content.Context.Revision != view.Revision {
		return CommunityAvatarView{}, ErrPolicyConflict
	}
	publisher, err := readCommunityAvatarPublisher(ctx, query, *view.Content)
	if err != nil {
		return CommunityAvatarView{}, err
	}
	view.Publisher = &publisher
	view.Package = &CommunityAvatarPackage{ID: recipientID, Ciphertext: wrapped}
	return view, nil
}

func (s *Store) DispatchCommunityAvatarRecovery(ctx context.Context, resolve ResolveSession,
	deliver func(CommunityAvatarView, string) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canReadCommunityAvatar(actor) {
			return ChannelRestricted
		}
		identity, err := currentRecoveryIdentity(state, actor, s.now().UnixMilli())
		if err != nil {
			return err
		}
		if identity.ID == "" {
			return ChannelRestricted
		}
		view, err := readCommunityAvatarView(ctx, conn, identity.ID, identity.AgreementKey)
		if err != nil {
			return err
		}
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		return deliver(view, head.Digest)
	})
}

func checkCommunityAvatarPackages(state State, packages []CommunityAvatarPackage) error {
	recipients := communityAvatarRecipientIDs(state)
	if len(packages) != len(recipients) || len(packages) == 0 {
		return ErrEpochRecipients
	}
	for index, packet := range packages {
		if packet.ID != recipients[index] || len(packet.Ciphertext) != EpochPackageSize {
			return ErrEpochRecipients
		}
	}
	return nil
}

func (s *Store) SaveCommunityAvatar(ctx context.Context, resolve ResolveSession, input CommunityAvatarUpdate) (int64, error) {
	binding := input.Context
	if binding.Scope != "" || binding.Revision < 2 || binding.Revision > 1<<53-1 || !validRotationID(binding.Operation) ||
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
	if !state.canReadCommunityAvatar(actor) || actor.ProfileID != binding.ProfileID || actor.DeviceID != binding.DeviceID {
		return 0, ChannelRestricted
	}
	now := s.now().UnixMilli()
	if decision := state.CheckGrant(state.Members[actor.ProfileID], Scope{}, editCommunity, now); decision != Allowed {
		return 0, decision
	}
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return 0, err
	}
	if serverID != binding.ServerID {
		return 0, InvalidAction
	}
	var revision int64
	var receipt string
	if err := tx.QueryRowContext(ctx, "SELECT revision,receipt FROM protected_community_avatar WHERE id=1").Scan(&revision, &receipt); err != nil {
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
		signer := state.PolicyDevices[actor.DeviceID].PublicKey
		if err := input.Packet.Verify(binding, signer); err != nil {
			return 0, err
		}
		if err := checkCommunityAvatarPackages(state, input.Packages); err != nil {
			return 0, err
		}
		body, err = json.Marshal(CommunityAvatarContent{Context: binding, Packet: *input.Packet, PolicyRevision: policyRevision})
		if err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_community_avatar_packages"); err != nil {
		return 0, err
	}
	for _, packet := range input.Packages {
		if _, err := tx.ExecContext(ctx, "INSERT INTO protected_community_avatar_packages (device_id,ciphertext,agreement_key) VALUES (?,?,?)",
			packet.ID, packet.Ciphertext, state.KeyRecipients[packet.ID].PublicKey); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_community_avatar SET revision=?,receipt=?,body=? WHERE id=1",
		binding.Revision, digest, body); err != nil {
		return 0, err
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "server.avatar", Kind: "server", ObjectID: "avatar"}); err != nil {
		return 0, err
	}
	return binding.Revision, tx.Commit()
}
