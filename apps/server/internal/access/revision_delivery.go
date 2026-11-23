package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

var ErrRevisionUnavailable = errors.New("protected text revision unavailable")

type RevisionDelivery struct {
	Digest          string                            `json:"digest"`
	Record          RevisionRecord                    `json:"record"`
	Package         *RevisionPackage                  `json:"package,omitempty"`
	Proof           *EpochPackageProof                `json:"proof,omitempty"`
	AuthorPolicy    *TextChannelPolicyDisclosure      `json:"authorPolicy,omitempty"`
	RecipientPolicy *TextChannelPolicyDisclosure      `json:"recipientPolicy,omitempty"`
	PersonalDeny    *RevisionPersonalDenyReadEvidence `json:"personalDeny,omitempty"`
	RoleViewDeny    *RevisionRoleViewDenyReadEvidence `json:"roleViewDeny,omitempty"`
}

type RevisionPersonalDenyReadEvidence struct {
	PersonalDenyReadEvidence
	PreviousRecipientPolicy *TextChannelPolicyDisclosure `json:"previousRecipientPolicy,omitempty"`
}

func (s *Store) DispatchRevision(ctx context.Context, resolve ResolveSession, verifyEpoch VerifyEpochRecord, verify VerifyRevision,
	source ResolveRevisionSource, channel string, position uint64, scoped *TextChannelPolicyProofCache, deliver func(RevisionDelivery) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.canUseDevice(actor) || position == 0 ||
			!state.CanDeliver(actor.ProfileID, channel, position) {
			return ChannelRestricted
		}
		message, err := readRevisionSource(ctx, conn, source, channel, position)
		if err != nil {
			return err
		}
		original := hexHash(message.Signature)
		var value RevisionDelivery
		var revision uint64
		var raw []byte
		err = conn.QueryRowContext(ctx, `SELECT revision,digest,record FROM protected_text_revisions
			WHERE channel_id=? AND position=? ORDER BY revision DESC LIMIT 1`, channel, position).Scan(&revision, &value.Digest, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrRevisionUnavailable
		}
		if err != nil {
			return err
		}
		record := &value.Record
		if json.Unmarshal(raw, record) != nil || record.Revision != revision || record.Original != original ||
			record.Author.ProfileID != message.Author || record.Archive.Record.ChannelID != channel ||
			(record.Packet.Checklist != nil) != (message.Checklist != nil) || !record.Packet.Checklist.valid() ||
			hexHash(record.Packet.Signature) != value.Digest || hexHash(record.Archive.Record.Signature) != record.ArchiveDigest {
			return ErrRevisionConflict
		}
		basis := RevisionBasis{RevisionExpectation: record.RevisionExpectation, Position: position, Original: original, Archive: record.Archive}
		attempt := RevisionAttempt{RevisionExpectation: record.RevisionExpectation, OperationID: record.OperationID, Packet: record.Packet}
		if err := verifyEpoch(ctx, conn, basis.Archive.Principal, basis.Archive.Record); err != nil {
			return err
		}
		if err := verify(ctx, conn, record.Author, channel, basis, attempt); err != nil {
			return err
		}
		if state.CheckGrant(state.Members[actor.ProfileID], state.scope(state.Channels[channel]), "history.full", 0) != Allowed {
			packageRecord, proof, err := readRevisionPackage(ctx, conn, channel, position, revision, actor.DeviceID,
				state.KeyRecipients[actor.DeviceID].PublicKey, record.Packet.RecipientDigest)
			if err != nil {
				return err
			}
			value.Package, value.Proof = &packageRecord, &proof
		}
		if scoped != nil {
			policy := EpochRecord{ChannelID: channel, Revision: record.PolicyRevision, PolicyDigest: record.PolicyDigest}
			value.AuthorPolicy, err = historicalTextSigner(ctx, conn, scoped, policy, record.Author, LiveEpoch)
			if err != nil {
				return err
			}
			archiveState, archivePolicy, err := readHistoricalTextSignerBasis(ctx, conn, record.Archive.Record)
			if err != nil {
				return err
			}
			record.Archive.SigningPolicy, err = historicalTextSignerDisclosure(archiveState, archivePolicy, record.Archive.Record,
				record.Archive.Principal, ArchiveEpoch, scoped)
			if err != nil {
				return err
			}
			if value.Package != nil {
				value.RecipientPolicy, err = historicalTextSigner(ctx, conn, scoped, policy, actor, LiveEpoch)
				if err != nil {
					return err
				}
			}
			if archivePolicy.Draft.Action == EditScopedChannelACLRoleRules {
				value.RoleViewDeny, err = revisionRoleViewDenyReadEvidence(ctx, conn, *record, actor, position, value.Package != nil, &scoped.history)
			} else {
				value.PersonalDeny, err = revisionPersonalDenyReadEvidence(ctx, conn, *record, actor, position, value.Package != nil, &scoped.history)
			}
			if err != nil {
				return err
			}
		}
		return deliver(value)
	})
}

func revisionPersonalDenyReadEvidence(ctx context.Context, query SessionQuery, record RevisionRecord, viewer Principal,
	position uint64, addressed bool, cache *textChannelPolicyTreeCache) (*RevisionPersonalDenyReadEvidence, error) {
	archive := record.Archive.Record
	if archive.ArchiveTransitionDigest == "" || archive.Purpose != ArchiveEpoch ||
		archive.Revision != record.PolicyRevision || archive.PolicyDigest != record.PolicyDigest {
		return nil, nil
	}
	basis, err := readRevisionPersonalDenyBasis(ctx, query, record.Archive, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	author, err := basis.authorDisclosure(record.Author, archive.ChannelID, position, cache)
	if err != nil || author == nil {
		return nil, err
	}
	// A reader can authenticate the individual author and package without
	// opening the preceding revision recipient set for this position.
	authorProof := *author
	authorProof.AudienceProof = nil
	authorProof.GroupedAudienceProof = nil
	compact := RevisionPersonalDenyReadEvidence{PersonalDenyReadEvidence: basis.evidence}
	compact.PreviousTextPolicy = &authorProof
	if addressed {
		compact.PreviousRecipientPolicy, err = revisionDenyRecipientDisclosure(basis.previous, basis.successor, basis.predecessor,
			viewer, archive.ChannelID, position, cache)
		if err != nil || compact.PreviousRecipientPolicy == nil {
			return nil, err
		}
	}
	return &compact, nil
}

func readRevisionPackage(ctx context.Context, conn *sql.Conn, channel string, position, revision uint64,
	device, publicKey, commitment string) (RevisionPackage, EpochPackageProof, error) {
	var empty RevisionPackage
	var proof EpochPackageProof
	rows, err := conn.QueryContext(ctx, `SELECT recipient_id,public_key,ciphertext FROM protected_text_revision_packages
		WHERE channel_id=? AND position=? AND revision=? ORDER BY recipient_id`, channel, position, revision)
	if err != nil {
		return empty, proof, err
	}
	defer rows.Close()
	var packages []RevisionPackage
	index := -1
	for rows.Next() {
		var item RevisionPackage
		if err := rows.Scan(&item.ID, &item.PublicKey, &item.Ciphertext); err != nil {
			return empty, proof, err
		}
		if item.ID == device && item.PublicKey == publicKey {
			index = len(packages)
		}
		packages = append(packages, item)
		if len(packages) > 8192 {
			return empty, proof, ErrEpochRecipients
		}
	}
	if err := rows.Err(); err != nil {
		return empty, proof, err
	}
	if index < 0 {
		return empty, proof, ErrRevisionUnavailable
	}
	root, siblings, err := revisionPackageTree(packages, index)
	if err != nil {
		return empty, proof, err
	}
	if root != commitment {
		return empty, proof, ErrEpochRecipients
	}
	return packages[index], EpochPackageProof{Index: index, Count: len(packages), Siblings: siblings}, nil
}
