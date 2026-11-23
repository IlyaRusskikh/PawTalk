package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"sync"
)

// TextChannelPolicyProofCache retains the current signed tree and one recently
// used historical tree. Visibility always comes from the live transaction.
type TextChannelPolicyProofCache struct {
	current textChannelPolicyTreeCache
	history textChannelPolicyTreeCache
}

type textChannelPolicyTreeCache struct {
	mu   sync.Mutex
	head [3]string
	tree *channelPolicyTree
}

type TextChannelPolicyDisclosure struct {
	ChannelID            string                  `json:"channelId"`
	Revision             int64                   `json:"revision"`
	PolicyDigest         string                  `json:"policyDigest"`
	Inclusion            ChannelPolicyInclusion  `json:"inclusion"`
	Recipient            *TextRecipientInclusion `json:"recipient,omitempty"`
	ArchiveAudience      string                  `json:"archiveAudience,omitempty"`
	LimitedAudience      string                  `json:"limitedAudience,omitempty"`
	AudienceProof        *revisionAudienceProof  `json:"audienceProof,omitempty"`
	GroupedAudienceProof *revisionAudienceProof  `json:"groupedAudienceProof,omitempty"`
	Rotation             *textRotationAudience   `json:"rotation,omitempty"`
	OrderAuthority       string                  `json:"orderAuthority,omitempty"`
	RoleRulesDigest      string                  `json:"roleRulesDigest,omitempty"`
}

func (cache *textChannelPolicyTreeCache) inclusion(state State, head PolicyProof, channel string) (ChannelPolicyInclusion, error) {
	tree, err := cache.treeFor(state, head)
	if err != nil {
		return ChannelPolicyInclusion{}, err
	}
	return tree.proof(channel)
}

func (cache *textChannelPolicyTreeCache) inclusionWithRoleRules(state State, head PolicyProof, channel string) (ChannelPolicyInclusion, string, error) {
	tree, err := cache.treeFor(state, head)
	if err != nil {
		return ChannelPolicyInclusion{}, "", err
	}
	proof, err := tree.proof(channel)
	return proof, tree.roleRuleDigests[channel], err
}

func (cache *textChannelPolicyTreeCache) treeFor(state State, head PolicyProof) (*channelPolicyTree, error) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	key := [3]string{head.Digest, head.Draft.TextProjectionRoot, head.Draft.TextProjectionSeed}
	if cache.tree == nil || cache.head != key {
		tree, err := state.textProjectionTree(head.Draft.TextProjectionSeed, head.Draft.TextProjectionVersion)
		if err != nil || tree.root() != head.Draft.TextProjectionRoot {
			return nil, ErrPolicyConflict
		}
		cache.tree, cache.head = tree, key
	}
	return cache.tree, nil
}

func (s *Store) DispatchTextChannelPolicyProof(ctx context.Context, resolve ResolveSession, channel string,
	cache *TextChannelPolicyProofCache, deliver func(TextChannelPolicyDisclosure) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) ||
			state.Channels[channel].Kind != "text" || !state.CanDeliver(actor.ProfileID, channel, 0) {
			return ChannelRestricted
		}
		proof, err := currentTextChannelDisclosure(ctx, conn, state, channel, actor.DeviceID, cache)
		if err != nil {
			return err
		}
		if proof == nil {
			return ErrPolicySignatureRequired
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(*proof)
	})
}

func currentTextChannelDisclosure(ctx context.Context, query SessionQuery, state State, channel, device string,
	cache *TextChannelPolicyProofCache) (*TextChannelPolicyDisclosure, error) {
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return nil, err
	}
	return textChannelDisclosure(state, head, channel, device, &cache.current, 0)
}

func textChannelDisclosure(state State, head PolicyProof, channel, device string,
	cache *textChannelPolicyTreeCache, position uint64) (*TextChannelPolicyDisclosure, error) {
	if head.Draft.TextProjectionRoot == "" {
		return nil, nil
	}
	inclusion, roleRulesDigest, err := cache.inclusionWithRoleRules(state, head, channel)
	if err != nil {
		return nil, err
	}
	result := &TextChannelPolicyDisclosure{ChannelID: channel, Revision: head.Draft.Revision,
		PolicyDigest: head.Draft.ResultDigest, Inclusion: inclusion}
	recipient := state.KeyRecipients[device]
	version := head.Draft.TextProjectionVersion
	if HasTextRecipientProjection(version) &&
		(recipient.Kind == "device" || recipient.Kind == "recovery") {
		result.RoleRulesDigest = roleRulesDigest
		var seed [32]byte
		if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
			return nil, ErrPolicyConflict
		}
		projection, err := state.textRecipientCommitment(channel, seed, device, head.Draft.TextProjectionVersion, position)
		if err != nil {
			return nil, err
		}
		result.Recipient, result.ArchiveAudience = projection.recipient, projection.archiveAudience
		result.LimitedAudience, result.AudienceProof = projection.limitedAudience, projection.audienceProof
		result.GroupedAudienceProof = projection.groupedAudienceProof
		result.Rotation = projection.rotation
		if head.Draft.TextProjectionVersion >= TextOrderAuthorityVersion {
			authority, _, err := state.channelOrderAuthority(channel, seed, "", head.Draft.TextProjectionVersion)
			if err != nil {
				return nil, err
			}
			result.OrderAuthority = authority.digest
		}
	}
	return result, nil
}

// historicalTextSigner proves the device named by a record that the caller
// can already read. It never serves as a device directory.
func historicalTextSigner(ctx context.Context, query SessionQuery, cache *TextChannelPolicyProofCache,
	record EpochRecord, signer Principal, purpose string) (*TextChannelPolicyDisclosure, error) {
	basis, head, err := readHistoricalTextSignerBasis(ctx, query, record)
	if err != nil {
		return nil, err
	}
	return historicalTextSignerDisclosure(basis, head, record, signer, purpose, cache)
}

func readHistoricalTextSignerBasis(ctx context.Context, query SessionQuery, record EpochRecord) (State, PolicyProof, error) {
	head, err := readAttestedProof(ctx, query, record.Revision)
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	if !HasTextRecipientProjection(head.Draft.TextProjectionVersion) || head.Draft.ResultDigest != record.PolicyDigest {
		return State{}, PolicyProof{}, ErrPolicyAttestationUnavailable
	}
	basis, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?", record.Revision))
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	digest, err := basis.PolicyDigest()
	if err != nil || digest != record.PolicyDigest {
		return State{}, PolicyProof{}, ErrPolicyConflict
	}
	return basis, head, nil
}

func historicalTextSignerDisclosure(basis State, head PolicyProof, record EpochRecord, signer Principal, purpose string,
	cache *TextChannelPolicyProofCache) (*TextChannelPolicyDisclosure, error) {
	if !basis.hasPolicyDevice(signer) || !basis.canLoadEpoch(signer, record.ChannelID, purpose) {
		return nil, ErrPolicyConflict
	}
	return textChannelDisclosure(basis, head, record.ChannelID, signer.DeviceID, &cache.history, 0)
}

// Epoch deliveries are bounded pages for one channel. Keep the last policy
// snapshot and separate signing disclosures by purpose.
type historicalEpochSigningPolicies struct {
	basis  State
	head   PolicyProof
	proofs map[struct {
		signer  Principal
		purpose string
	}]*TextChannelPolicyDisclosure
}

func (page *historicalEpochSigningPolicies) disclose(ctx context.Context, query SessionQuery, cache *TextChannelPolicyProofCache,
	epoch EpochProof) (*TextChannelPolicyDisclosure, error) {
	record := epoch.Record
	if page.head.Draft.Revision != record.Revision || page.head.Draft.ResultDigest != record.PolicyDigest {
		var err error
		page.basis, page.head, err = readHistoricalTextSignerBasis(ctx, query, record)
		if err != nil {
			return nil, err
		}
		clear(page.proofs)
	}
	if page.proofs == nil {
		page.proofs = make(map[struct {
			signer  Principal
			purpose string
		}]*TextChannelPolicyDisclosure)
	}
	key := struct {
		signer  Principal
		purpose string
	}{epoch.Principal, record.Purpose}
	if proof, found := page.proofs[key]; found {
		return proof, nil
	}
	proof, err := historicalTextSignerDisclosure(page.basis, page.head, record, epoch.Principal, record.Purpose, cache)
	if err == nil {
		page.proofs[key] = proof
	}
	return proof, err
}
