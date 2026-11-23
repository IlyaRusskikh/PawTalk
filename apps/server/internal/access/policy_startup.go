package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
)

// VerifyActivatedPolicyChain starts at the immutable owner anchor and replays
// every authorized mutation up to the stored current policy.
func VerifyActivatedPolicyChain(ctx context.Context, tx *sql.Tx, anchor string, owner Principal, verify VerifyPolicyDraft) error {
	head, err := ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return err
	}
	if head.Digest == "" || verify == nil {
		return ErrPolicySignatureRequired
	}
	rows, err := tx.QueryContext(ctx, "SELECT revision,operation_id,digest,record,snapshot FROM protected_policy_proofs ORDER BY revision")
	if err != nil {
		return err
	}
	defer rows.Close()
	var previous State
	var previousProof PolicyProof
	admissionFloor := make(map[string]uint64)
	next := int64(1)
	for rows.Next() {
		var revision int64
		var operation, storedDigest string
		var record, snapshot []byte
		if err := rows.Scan(&revision, &operation, &storedDigest, &record, &snapshot); err != nil {
			return err
		}
		var proof PolicyProof
		var state State
		if err := json.Unmarshal(record, &proof); err != nil {
			return err
		}
		if err := json.Unmarshal(snapshot, &state); err != nil {
			return err
		}
		draft := proof.Draft
		signed := sha256.Sum256(draft.Signature)
		applied := sha256.Sum256(snapshot)
		if revision != next || draft.Revision != revision || draft.OperationID != operation ||
			draft.PreviousDigest != previousProof.Digest || storedDigest != hex.EncodeToString(signed[:]) ||
			draft.ResultDigest != hex.EncodeToString(applied[:]) {
			return ErrPolicyConflict
		}
		if revision == 1 {
			if storedDigest != anchor || proof.Principal != owner || draft.Action != AnchorPolicy ||
				state.Owner != owner.ProfileID || !state.hasPolicyDevice(owner) {
				return ErrPolicyConflict
			}
		}
		if err := verify(ctx, tx, proof.Principal, draft); err != nil {
			return err
		}
		if err := replayActivatedPolicy(previous, previousProof, state, proof, admissionFloor); err != nil {
			return err
		}
		for channel, entries := range state.Admissions {
			for _, admission := range entries {
				admissionFloor[channel] = max(admissionFloor[channel], admission.FirstPosition)
			}
		}
		previous = state
		proof.Digest = storedDigest
		previousProof = proof
		next++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if head.Digest != previousProof.Digest || head.Draft.Revision != next-1 {
		return ErrPolicyConflict
	}
	return nil
}

func replayActivatedPolicy(previous State, previousProof PolicyProof, signed State, proof PolicyProof, floor map[string]uint64) error {
	draft := proof.Draft
	state := previous
	revision := previousProof.Draft.Revision
	if revision == 0 {
		state = signed
		state.Admissions = nil
		revision = 1
	} else {
		state.PolicyAnchored = true
	}
	// A signed snapshot omits live counters. The new admission positions
	// testify to the counter only at the instant this revision was applied.
	// Existing continuous admissions are preserved by preparePolicyDraft.
	for id, channel := range state.Channels {
		var first uint64
		for profile, admission := range signed.Admissions[id] {
			if state.Admissions[id][profile].FirstPosition != 0 {
				continue
			}
			if admission.FirstPosition == 0 || admission.FirstPosition < floor[id] ||
				first != 0 && admission.FirstPosition != first {
				return ErrPolicyConflict
			}
			first = admission.FirstPosition
		}
		channel.NextPosition = max(1, floor[id], first)
		state.Channels[id] = channel
	}
	if previousProof.Digest == "" {
		var err error
		state, err = normalizeInitialState(state)
		if err != nil {
			return ErrPolicyConflict
		}
	}
	expected, err := preparePolicyDraft(&state, revision, previousProof, proof.Principal, draft)
	if err != nil || expected.Revision != draft.Revision || expected.ResultDigest != draft.ResultDigest ||
		expected.TextProjectionRoot != draft.TextProjectionRoot {
		return ErrPolicyConflict
	}
	return nil
}
