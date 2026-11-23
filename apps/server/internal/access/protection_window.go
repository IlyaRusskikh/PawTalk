package access

import (
	"context"
	"database/sql"
	"errors"
)

// ProtectionWindow describes the operational live-epoch window for one
// visible text channel. The policy head identifies the policy against
// which the device must verify eligibility and its own epoch package.
type ProtectionWindow struct {
	PolicyRevision     int64  `json:"policyRevision"`
	PolicyHead         string `json:"policyHead"`
	ServerNow          int64  `json:"serverNow"`
	CurrentGeneration  uint64 `json:"currentGeneration"`
	PreviousGeneration uint64 `json:"previousGeneration"`
	CurrentCutoff      int64  `json:"currentCutoff"`
	PreviousCutoff     int64  `json:"previousCutoff"`
	NeedsFresh         bool   `json:"needsFresh"`
	CurrentKeyID       string `json:"currentKeyId,omitempty"`
	DeferredSend       bool   `json:"deferredSend"`
}

func (s *Store) DispatchProtectionWindow(ctx context.Context, resolve ResolveSession, channel string,
	verifyPolicy VerifyPolicyDraft, verifyEpoch VerifyEpochRecord, deliver func(ProtectionWindow) error) error {
	if verifyPolicy == nil || verifyEpoch == nil {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || state.Channels[channel].Kind != "text" ||
			!state.CanDeliver(actor.ProfileID, channel, 0) {
			return ChannelRestricted
		}
		var revision int64
		if err := conn.QueryRowContext(ctx, "SELECT revision FROM protected_policy WHERE id=1").Scan(&revision); err != nil {
			return err
		}
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		if err := checkPolicyHead(state, revision, head); err != nil {
			return err
		}
		if err := verifyPolicy(ctx, conn, head.Principal, head.Draft); err != nil {
			return err
		}

		window := state.EpochWindows[channel]
		result := ProtectionWindow{PolicyRevision: revision, PolicyHead: head.Digest, CurrentGeneration: window.Current,
			CurrentCutoff: window.CurrentCutoff, PreviousCutoff: window.PreviousCutoff, NeedsFresh: window.NeedsFresh, DeferredSend: true}
		if window.PreviousCutoff > 0 {
			if window.Current <= 1 {
				return ErrEpochConflict
			}
			result.PreviousGeneration = window.Current - 1
		}
		if window.Current > 0 {
			var keyID, digest string
			var raw []byte
			err := conn.QueryRowContext(ctx, `SELECT key_id,digest,record FROM protected_epochs
				WHERE channel_id=? AND purpose=? AND generation=?`, channel, LiveEpoch, window.Current).Scan(&keyID, &digest, &raw)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrEpochConflict
			}
			if err != nil {
				return err
			}
			epoch, err := decodeEpoch(raw, channel, LiveEpoch, keyID, digest, window.Current)
			if err != nil {
				return err
			}
			if err := verifyEpoch(ctx, conn, epoch.Principal, epoch.Record); err != nil {
				return err
			}
			result.CurrentKeyID = epoch.Record.KeyID
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		result.ServerNow = s.now().UnixMilli()
		return deliver(result)
	})
}
