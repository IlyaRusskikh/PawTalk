package access

import "context"

// archiveTransitionProofs belongs to one locked dispatch, channel and viewer.
// The caller must verify each delivered epoch separately.
type archiveTransitionProofs struct {
	head          EpochProof
	headLoaded    bool
	personal      *personalDenyReadBasis
	role          *roleViewDenyBasis
	roleSuccessor State
	roleSigners   map[Principal]*RoleViewDenyReadEvidence
	basisLoaded   bool
	previousTree  textChannelPolicyTreeCache
}

func (page *archiveTransitionProofs) disclose(ctx context.Context, query SessionQuery, current State, viewer Principal,
	proof *EpochProof, verify VerifyEpochRecord) error {
	record := proof.Record
	generation := current.currentGeneration(record.ChannelID, ArchiveEpoch)
	if record.Purpose != ArchiveEpoch || record.ArchiveTransitionDigest == "" || record.Generation > generation {
		return nil
	}
	if !page.headLoaded {
		if record.Generation == generation {
			page.head = *proof
		} else {
			var key string
			if err := query.QueryRowContext(ctx, "SELECT key_id FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=?",
				record.ChannelID, ArchiveEpoch, generation).Scan(&key); err != nil {
				return err
			}
			head, err := readEpoch(ctx, query, record.ChannelID, ArchiveEpoch, key)
			if err != nil {
				return err
			}
			page.head = head
		}
		page.headLoaded = true
	}
	head := page.head.Record
	if record.Revision != head.Revision || record.PolicyDigest != head.PolicyDigest || record.ArchiveTransitionDigest != head.ArchiveTransitionDigest {
		return nil
	}
	if !page.basisLoaded {
		if record.Generation != generation {
			if err := verify(ctx, query, page.head.Principal, head); err != nil {
				return err
			}
		}
		policy, err := readAttestedProof(ctx, query, head.Revision)
		if err != nil {
			return err
		}
		if policy.Draft.Action == RedeemPolicyInvite {
			// Invite signer evidence comes from each immutable epoch even if
			// the latest archive generation now belongs to a different policy.
			page.basisLoaded = true
			return nil
		}
		if policy.Draft.Action == EditScopedChannelACLRoleRules {
			successor, signed, err := readHistoricalTextSignerBasis(ctx, query, head)
			if err != nil {
				return err
			}
			if retainedPersonalDenyReader(successor, current, head, viewer) {
				page.role, err = verifiedRoleViewDenyBasis(ctx, query, successor, signed, head, viewer, &page.previousTree)
				if err != nil {
					return err
				}
				page.roleSuccessor = successor
				page.roleSigners = make(map[Principal]*RoleViewDenyReadEvidence)
			}
		} else {
			page.personal, err = readPersonalDenyBasis(ctx, query, current, head, viewer, &page.previousTree)
			if err != nil {
				return err
			}
		}
		page.basisLoaded = true
	}
	if page.role != nil {
		witness, found := page.roleSigners[proof.Principal]
		if !found {
			var err error
			witness, err = page.role.disclose(page.roleSuccessor, *proof, &page.previousTree)
			if err != nil {
				return err
			}
			page.roleSigners[proof.Principal] = witness
		}
		proof.ArchiveRoleViewDeny = witness
	} else if page.personal != nil {
		var err error
		proof.ArchivePersonalDeny, err = page.personal.disclose(current, *proof, &page.previousTree)
		return err
	}
	return nil
}
