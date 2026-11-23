package access

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
)

const channelLayoutSchema = `CREATE TABLE IF NOT EXISTS protected_channel_layout (
	id INTEGER PRIMARY KEY CHECK(id=1), ordering BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS protected_channel_layout_receipts (
	device_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, record BLOB NOT NULL,
	PRIMARY KEY(device_id,operation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS protected_channel_layout_digest ON protected_channel_layout_receipts(digest);`

func EnsureChannelLayoutSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, channelLayoutSchema)
	return err
}

type ChannelLayoutChange struct {
	OperationID  string `json:"operationId"`
	Source       string `json:"source"`
	Anchor       string `json:"anchor"`
	After        bool   `json:"after"`
	Revision     int64  `json:"revision"`
	PolicyHead   string `json:"policyHead"`
	OrderBasis   string `json:"orderBasis"`
	BasisVersion int    `json:"basisVersion,omitempty"`
	Signature    []byte `json:"signature"`
}

type ChannelLayoutReceipt struct {
	Digest   string `json:"digest"`
	Existing bool   `json:"existing"`
}

type ChannelLayoutEvidence struct {
	Change          ChannelLayoutChange         `json:"change"`
	Author          Principal                   `json:"author"`
	Digest          string                      `json:"digest"`
	SourceAuthority *ChannelOrderAuthorityProof `json:"sourceAuthority"`
	AnchorAuthority *ChannelOrderAuthorityProof `json:"anchorAuthority"`
}

// An exact receipt is required so the endpoint cannot enumerate hidden moves.
// Skip it as a whole if either channel or its historical grouping is private.
func (s *Store) DispatchChannelLayoutEvidence(ctx context.Context, resolve ResolveSession, source, digest string,
	cache *TextChannelPolicyProofCache, verify VerifyChannelLayout, deliver func(*ChannelLayoutEvidence) error) error {
	if !validRotationID(source) || !isDigest(digest) || cache == nil || verify == nil {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, viewer Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(viewer) || !state.CanDeliver(viewer.ProfileID, source, 0) {
			return ChannelRestricted
		}
		var evidence ChannelLayoutEvidence
		var deviceID, operationID string
		var raw []byte
		err := conn.QueryRowContext(ctx, `SELECT device_id,operation_id,digest,record FROM protected_channel_layout_receipts
			WHERE digest=? AND json_extract(CAST(record AS TEXT),'$.source')=? LIMIT 1`, digest, source).
			Scan(&deviceID, &operationID, &evidence.Digest, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			return deliver(nil)
		}
		if err != nil {
			return err
		}
		change := &evidence.Change
		if json.Unmarshal(raw, change) != nil || change.Source != source || change.OperationID != operationID ||
			!validRotationID(change.Anchor) || change.Anchor == source || hexHash(change.Signature) != evidence.Digest {
			return ErrPolicyConflict
		}
		if change.BasisVersion != 2 && change.BasisVersion != 3 {
			return deliver(nil)
		}
		if !state.CanDeliver(viewer.ProfileID, change.Anchor, 0) {
			return deliver(nil)
		}
		head, err := readAttestedProof(ctx, conn, change.Revision)
		if err != nil {
			return err
		}
		if head.Digest != change.PolicyHead {
			return ErrPolicyConflict
		}
		historical, revision, err := readState(conn.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?", change.Revision))
		if err != nil {
			return err
		}
		policyDigest, err := historical.PolicyDigest()
		if err != nil || revision != head.Draft.Revision || policyDigest != head.Draft.ResultDigest {
			return ErrPolicyConflict
		}
		for _, id := range []string{source, change.Anchor} {
			before, current := historical.Channels[id], state.Channels[id]
			if before.Kind != current.Kind || before.CategoryID != current.CategoryID {
				return deliver(nil)
			}
		}
		evidence.Author = Principal{DeviceID: deviceID, ProfileID: historical.PolicyDevices[deviceID].ProfileID}
		if err := verify(ctx, conn, evidence.Author, *change); err != nil {
			return err
		}
		evidence.SourceAuthority, err = orderAuthorityDisclosure(historical, head, source, deviceID, &cache.history)
		if err != nil {
			return err
		}
		evidence.AnchorAuthority, err = orderAuthorityDisclosure(historical, head, change.Anchor, deviceID, &cache.history)
		if err != nil {
			return err
		}
		return deliver(&evidence)
	})
}

func ChannelLayoutFrame(serverID string, actor Principal, change ChannelLayoutChange) ([]byte, error) {
	domain := "pawtalk-channel-layout-v1"
	if change.BasisVersion == 2 {
		domain = "pawtalk-channel-layout-v2"
	}
	if change.BasisVersion == 3 {
		domain = "pawtalk-channel-layout-v3"
	}
	return SignatureFrame(domain, serverID, actor.ProfileID, actor.DeviceID, change.OperationID,
		change.Source, change.Anchor, strconv.FormatBool(change.After), strconv.FormatInt(change.Revision, 10), change.PolicyHead, change.OrderBasis)
}

type VerifyChannelLayout func(context.Context, SessionQuery, Principal, ChannelLayoutChange) error

func applyChannelLayout(ctx context.Context, query SessionQuery, state *State) (bool, error) {
	var raw []byte
	err := query.QueryRowContext(ctx, "SELECT ordering FROM protected_channel_layout WHERE id=1").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var order []string
	if err := json.Unmarshal(raw, &order); err != nil {
		return false, err
	}
	state.ChannelOrder = order
	return true, nil
}

func channelLayoutBasis(ctx context.Context, query SessionQuery, state *State, actor string, change PolicyResourceChange, seed string) (string, error) {
	if change.ID == change.AnchorID {
		return "", InvalidAction
	}
	editable, err := state.editableChannelOrder(actor, change.ID, change.MixedOrder)
	if err != nil {
		return "", err
	}
	if _, ok := state.Channels[change.AnchorID]; !ok || !editable(change.AnchorID) || !editable(change.ID) {
		return "", ChannelRestricted
	}
	if _, err := applyChannelLayout(ctx, query, state); err != nil {
		return "", err
	}
	ids := make([]string, 0)
	for _, id := range orderedResources(state.ChannelOrder, state.Channels) {
		if editable(id) {
			ids = append(ids, id)
		}
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return "", err
	}
	if seed == "" {
		return hexHash(raw), nil
	}
	key, err := hex.DecodeString(seed)
	if err != nil || len(key) != sha256.Size {
		return "", ErrPolicyConflict
	}
	frame, err := SignatureFrame("pawtalk-channel-layout-basis-v2", actor, change.ID, string(raw))
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(frame)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func saveChannelLayout(ctx context.Context, tx *sql.Tx, state State) error {
	raw, err := json.Marshal(state.ChannelOrder)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_channel_layout (id,ordering) VALUES (1,?)
		ON CONFLICT(id) DO UPDATE SET ordering=excluded.ordering`, raw)
	return err
}

func (s *Store) CommitChannelLayout(ctx context.Context, resolve ResolveSession, verify VerifyChannelLayout,
	change ChannelLayoutChange) (ChannelLayoutReceipt, error) {
	var receipt ChannelLayoutReceipt
	if verify == nil || !validRotationID(change.OperationID) || !validRotationID(change.Source) || !validRotationID(change.Anchor) ||
		change.Source == change.Anchor || change.Revision < 1 || !isDigest(change.PolicyHead) || !isDigest(change.OrderBasis) ||
		(change.BasisVersion != 0 && change.BasisVersion != 2 && change.BasisVersion != 3) || len(change.Signature) != 64 {
		return receipt, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return receipt, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return receipt, err
	}
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
		return receipt, ChannelRestricted
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return receipt, err
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return receipt, err
	}
	resource := PolicyResourceChange{ID: change.Source, AnchorID: change.Anchor, After: change.After, MixedOrder: change.BasisVersion == 3}
	basis, err := channelLayoutBasis(ctx, tx, &state, actor.ProfileID, resource, head.Draft.TextProjectionSeed)
	if err != nil {
		return receipt, err
	}
	if err := verify(ctx, tx, actor, change); err != nil {
		return receipt, err
	}
	digest := hexHash(change.Signature)
	var existing string
	err = tx.QueryRowContext(ctx, "SELECT digest FROM protected_channel_layout_receipts WHERE device_id=? AND operation_id=?",
		actor.DeviceID, change.OperationID).Scan(&existing)
	if err == nil {
		if existing != digest {
			return receipt, ErrPolicyConflict
		}
		return ChannelLayoutReceipt{Digest: digest, Existing: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return receipt, err
	}
	if change.BasisVersion == 0 && basis != change.OrderBasis {
		basis, err = channelLayoutBasis(ctx, tx, &state, actor.ProfileID, resource, "")
		if err != nil {
			return receipt, err
		}
	}
	if head.Draft.TextProjectionVersion < TextOrderAuthorityVersion || revision != change.Revision || head.Digest != change.PolicyHead || basis != change.OrderBasis {
		return receipt, ErrPolicyConflict
	}
	if err := state.reorderChannel(actor.ProfileID, change.Source, change.Anchor, change.After, resource.MixedOrder); err != nil {
		return receipt, err
	}
	if err := saveChannelLayout(ctx, tx, state); err != nil {
		return receipt, err
	}
	record, err := json.Marshal(change)
	if err != nil {
		return receipt, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_channel_layout_receipts(device_id,operation_id,digest,record) VALUES(?,?,?,?)`,
		actor.DeviceID, change.OperationID, digest, record); err != nil {
		return receipt, err
	}
	auditChange := AuditChange{}
	if change.BasisVersion == 2 || change.BasisVersion == 3 {
		auditChange.LayoutDigest = digest
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: s.now().UnixMilli(), Actor: actor.ProfileID, Action: OrderPolicyChannel,
		Kind: "channel", ObjectID: change.Source, ChannelID: change.Source, Change: auditChange}); err != nil {
		return receipt, err
	}
	if err := tx.Commit(); err != nil {
		return receipt, err
	}
	return ChannelLayoutReceipt{Digest: digest}, nil
}
