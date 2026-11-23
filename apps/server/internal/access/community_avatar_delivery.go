package access

import (
	"context"
	"database/sql"
	"slices"
)

const communityAvatarDeliveryLimit = 4

type CommunityAvatarPendingDelivery struct {
	Revision int64                    `json:"revision"`
	Audience *CommunityAvatarAudience `json:"audience,omitempty"`
}

type CommunityAvatarDelivery struct {
	Revision   int64                    `json:"revision"`
	PolicyHead string                   `json:"policyHead"`
	Packages   []CommunityAvatarPackage `json:"packages"`
}

func communityAvatarHolder(ctx context.Context, query SessionQuery, deviceID, agreementKey string) (int64, bool, error) {
	var revision int64
	var holder bool
	err := query.QueryRowContext(ctx, `SELECT a.revision,a.body IS NOT NULL AND EXISTS (
		SELECT 1 FROM protected_community_avatar_packages p WHERE p.device_id=? AND p.agreement_key=?)
		FROM protected_community_avatar a WHERE a.id=1`, deviceID, agreementKey).Scan(&revision, &holder)
	return revision, holder, err
}

func (s *Store) DispatchCommunityAvatarPending(ctx context.Context, resolve ResolveSession,
	deliver func(CommunityAvatarPendingDelivery) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canReadCommunityAvatar(actor) {
			return ChannelRestricted
		}
		revision, holder, err := communityAvatarHolder(ctx, conn, actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey)
		if err != nil {
			return err
		}
		result := CommunityAvatarPendingDelivery{Revision: revision}
		if !holder {
			return deliver(result)
		}
		rows, err := conn.QueryContext(ctx, "SELECT device_id,agreement_key FROM protected_community_avatar_packages")
		if err != nil {
			return err
		}
		defer rows.Close()
		covered := make(map[string]bool)
		for rows.Next() {
			var id, key string
			if err := rows.Scan(&id, &key); err != nil {
				return err
			}
			covered[id] = key == state.KeyRecipients[id].PublicKey
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		pending := make([]string, 0, communityAvatarDeliveryLimit)
		ownRecovery := state.RecoveryIdentities[actor.ProfileID].ID
		if ownRecovery != "" && !covered[ownRecovery] && state.canReceiveCommunityAvatar(ownRecovery, state.KeyRecipients[ownRecovery]) {
			pending = append(pending, ownRecovery)
		}
		for _, id := range communityAvatarRecipientIDs(state) {
			if !covered[id] && id != ownRecovery {
				pending = append(pending, id)
				if len(pending) == communityAvatarDeliveryLimit {
					break
				}
			}
		}
		if len(pending) == 0 {
			return deliver(result)
		}
		slices.Sort(pending)
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		proof, err := prepareCommunityAvatarProof(state, head)
		if err != nil {
			return err
		}
		result.Audience = &CommunityAvatarAudience{Revision: head.Draft.Revision, Head: head.Digest, Basis: proof.basis,
			Recipients: make([]CommunityAvatarRecipientProof, 0, len(pending))}
		for _, id := range pending {
			key := state.KeyRecipients[id]
			recipient, err := proof.deviceKey(Principal{ProfileID: key.ProfileID, DeviceID: id}, key.Kind)
			if err != nil {
				return err
			}
			result.Audience.Recipients = append(result.Audience.Recipients, recipient)
		}
		return deliver(result)
	})
}

func (s *Store) DeliverCommunityAvatar(ctx context.Context, resolve ResolveSession, input CommunityAvatarDelivery, recoverOwn bool) error {
	if input.Revision < 2 || !isDigest(input.PolicyHead) || len(input.Packages) < 1 || len(input.Packages) > communityAvatarDeliveryLimit {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, policyRevision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if !state.canReadCommunityAvatar(actor) {
		return ChannelRestricted
	}
	holderID, holderKey := actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey
	if recoverOwn {
		if len(input.Packages) != 1 || input.Packages[0].ID != actor.DeviceID {
			return ChannelRestricted
		}
		identity, err := currentRecoveryIdentity(state, actor, s.now().UnixMilli())
		if err != nil {
			return err
		}
		if identity.ID == "" {
			return ChannelRestricted
		}
		holderID, holderKey = identity.ID, identity.AgreementKey
	}
	revision, holder, err := communityAvatarHolder(ctx, tx, holderID, holderKey)
	if err != nil {
		return err
	}
	if revision != input.Revision {
		return ErrCommunityAvatarChanged
	}
	if !holder {
		return ChannelRestricted
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return err
	}
	if err := checkPolicyHead(state, policyRevision, head); err != nil {
		return err
	}
	if head.Digest != input.PolicyHead {
		return ErrPolicyConflict
	}
	previous := ""
	for _, packet := range input.Packages {
		if !isDigest(packet.ID) || packet.ID <= previous || len(packet.Ciphertext) != EpochPackageSize {
			return InvalidAction
		}
		recipient := state.KeyRecipients[packet.ID]
		if !state.canReceiveCommunityAvatar(packet.ID, recipient) {
			return ChannelRestricted
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_community_avatar_packages (device_id,ciphertext,agreement_key) VALUES (?,?,?)
			ON CONFLICT(device_id) DO UPDATE SET ciphertext=excluded.ciphertext,agreement_key=excluded.agreement_key
			WHERE agreement_key!=excluded.agreement_key`, packet.ID, packet.Ciphertext, recipient.PublicKey); err != nil {
			return err
		}
		previous = packet.ID
	}
	return tx.Commit()
}
