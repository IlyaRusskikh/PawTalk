package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
)

const revisionSchema = `
CREATE TABLE IF NOT EXISTS protected_text_revisions (
	channel_id TEXT NOT NULL,
	position INTEGER NOT NULL CHECK(position>0),
	revision INTEGER NOT NULL CHECK(revision>1),
	digest TEXT NOT NULL,
	record BLOB NOT NULL,
	PRIMARY KEY(channel_id,position,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS protected_text_revision_packages (
	channel_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	revision INTEGER NOT NULL,
	recipient_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	ciphertext BLOB NOT NULL CHECK(length(ciphertext)=80),
	PRIMARY KEY(channel_id,position,revision,recipient_id),
	FOREIGN KEY(channel_id,position,revision) REFERENCES protected_text_revisions(channel_id,position,revision) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS protected_text_revision_receipts (
	device_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	request_digest TEXT NOT NULL,
	revision INTEGER NOT NULL,
	digest TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY(device_id,operation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS protected_text_revision_rate ON protected_text_revision_receipts(device_id,created_at);
CREATE TABLE IF NOT EXISTS protected_timeline_changes (
	sequence INTEGER PRIMARY KEY,
	cursor TEXT NOT NULL UNIQUE CHECK(length(cursor)=32),
	channel_id TEXT NOT NULL,
	position INTEGER NOT NULL CHECK(position>0),
	revision INTEGER NOT NULL CHECK(revision=0 OR revision>1),
	UNIQUE(channel_id,position,revision)
) STRICT;
CREATE INDEX IF NOT EXISTS protected_timeline_changes_channel ON protected_timeline_changes(channel_id,sequence);`

const timelineChangeBackfill = `
INSERT OR IGNORE INTO protected_timeline_changes(cursor,channel_id,position,revision)
	SELECT cursor,channel_id,position,0 FROM protected_message_deletions ORDER BY sequence;
INSERT OR IGNORE INTO protected_timeline_changes(cursor,channel_id,position,revision)
	SELECT substr(digest,1,32),channel_id,position,revision FROM protected_text_revisions ORDER BY rowid;`

func EnsureRevisionSchema(ctx context.Context, tx *sql.Tx) error {
	var initialized bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_timeline_changes')").
		Scan(&initialized); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, revisionSchema); err != nil || initialized {
		return err
	}
	_, err := tx.ExecContext(ctx, timelineChangeBackfill)
	return err
}

var ErrRevisionConflict = errors.New("protected text revision conflict")

type RevisionBasis struct {
	RevisionExpectation
	Position        uint64                        `json:"position"`
	Original        string                        `json:"originalDigest"`
	Archive         EpochProof                    `json:"archive"`
	Recipients      []RevisionRecipient           `json:"recipients"`
	AuthorPolicy    *TextChannelPolicyDisclosure  `json:"authorPolicy,omitempty"`
	GroupedAudience *RevisionGroupedAudience      `json:"groupedAudience,omitempty"`
	PersonalDeny    *RevisionPersonalDenyEvidence `json:"personalDeny,omitempty"`
	RoleViewDeny    *RevisionRoleViewDenyEvidence `json:"roleViewDeny,omitempty"`
}

type RevisionExpectation struct {
	Revision       uint64 `json:"revision"`
	PreviousDigest string `json:"previousDigest"`
	PolicyRevision int64  `json:"policyRevision"`
	PolicyDigest   string `json:"policyDigest"`
	ArchiveDigest  string `json:"archiveDigest"`
}

type RevisionRecipient struct {
	ID        string `json:"id"`
	PublicKey string `json:"publicKey"`
}

type RevisionPacket struct {
	Nonce           []byte            `json:"nonce"`
	Ciphertext      []byte            `json:"ciphertext"`
	ArchivePackage  []byte            `json:"archivePackage"`
	RecipientDigest string            `json:"recipientDigest"`
	Signature       []byte            `json:"signature"`
	Checklist       *MessageChecklist `json:"checklist,omitempty"`
}

type RevisionPackage struct {
	RevisionRecipient
	Ciphertext []byte `json:"ciphertext"`
}

type RevisionAttempt struct {
	RevisionExpectation
	OperationID string            `json:"operationId"`
	Packet      RevisionPacket    `json:"packet"`
	Packages    []RevisionPackage `json:"packages"`
}

type RevisionReceipt struct {
	Revision uint64 `json:"revision"`
	Digest   string `json:"digest"`
	Existing bool   `json:"existing"`
}

type RevisionRecord struct {
	RevisionExpectation
	Author      Principal      `json:"author"`
	Original    string         `json:"originalDigest"`
	Archive     EpochProof     `json:"archive"`
	OperationID string         `json:"operationId"`
	EditedAt    int64          `json:"editedAt"`
	Packet      RevisionPacket `json:"packet"`
}

type RevisionSource struct {
	Author    string
	Signature []byte
	Checklist *ChecklistDefinition
}

type ResolveRevisionSource func(context.Context, SessionQuery, string, uint64) (RevisionSource, error)
type VerifyRevision func(context.Context, SessionQuery, Principal, string, RevisionBasis, RevisionAttempt) error

func hexHash(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func readRevisionSource(ctx context.Context, query SessionQuery, imported ResolveRevisionSource, channel string, position uint64) (RevisionSource, error) {
	var source RevisionSource
	var isChecklist bool
	err := query.QueryRowContext(ctx, `SELECT m.profile_id,m.signature,c.definition IS NOT NULL FROM protected_messages m
		LEFT JOIN protected_checklists c ON c.channel_id=m.channel_id AND c.position=m.position
		WHERE m.channel_id=? AND m.position=? AND NOT EXISTS(SELECT 1 FROM protected_polls p
			WHERE p.channel_id=m.channel_id AND p.position=m.position)`, channel, position).Scan(&source.Author, &source.Signature, &isChecklist)
	if errors.Is(err, sql.ErrNoRows) && imported != nil {
		source, err = imported(ctx, query, channel, position)
	} else if err == nil && isChecklist {
		list, loadErr := resolveMessageChecklist(ctx, query, nil, channel, position)
		source.Checklist, err = &list, loadErr
	}
	if errors.Is(err, sql.ErrNoRows) {
		return RevisionSource{}, ChannelRestricted
	}
	if err != nil {
		return RevisionSource{}, err
	}
	if len(source.Signature) != 64 {
		return RevisionSource{}, InvalidPolicy
	}
	return source, nil
}

func (s *Store) authorizeRevision(ctx context.Context, query SessionQuery, state State, actor Principal,
	channel string, position uint64, source ResolveRevisionSource) (RevisionSource, error) {
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.canUseDevice(actor) ||
		!state.CanDeliver(actor.ProfileID, channel, position) || position == 0 {
		return RevisionSource{}, ChannelRestricted
	}
	original, err := readRevisionSource(ctx, query, source, channel, position)
	if err != nil {
		return RevisionSource{}, err
	}
	if original.Author != actor.ProfileID {
		return RevisionSource{}, MissingGrant
	}
	subject := state.Members[actor.ProfileID]
	timeout, err := readTimeout(ctx, query, subject)
	if err != nil {
		return RevisionSource{}, err
	}
	subject.TimeoutUntil = timeout.Deadline
	if result := state.CheckGrant(subject, state.scope(state.Channels[channel]), "message.send", s.now().UnixMilli()); result != Allowed {
		return RevisionSource{}, result
	}
	return original, nil
}

func revisionBasis(ctx context.Context, query SessionQuery, state State, channel string, position uint64, original string) (RevisionBasis, error) {
	basis := RevisionBasis{Position: position, Original: original, Recipients: []RevisionRecipient{}}
	var pending bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_rotation_tasks
		WHERE channel_id=? AND purpose='archive')`, channel).Scan(&pending); err != nil {
		return basis, err
	}
	generation := state.currentGeneration(channel, ArchiveEpoch)
	if pending || generation == 0 {
		return basis, ErrEpochStale
	}
	var raw []byte
	var key string
	err := query.QueryRowContext(ctx, `SELECT key_id,digest,record FROM protected_epochs
		WHERE channel_id=? AND purpose='archive' AND generation=?`, channel, generation).Scan(&key, &basis.ArchiveDigest, &raw)
	if err != nil {
		return basis, err
	}
	basis.Archive, err = decodeEpoch(raw, channel, ArchiveEpoch, key, basis.ArchiveDigest, generation)
	if err != nil {
		return basis, err
	}
	if basis.Archive.Record.ArchiveWrapKey == "" {
		return basis, ErrEpochStale
	}
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return basis, err
	}
	var policyRevision int64
	if err := query.QueryRowContext(ctx, "SELECT revision FROM protected_policy WHERE id=1").Scan(&policyRevision); err != nil {
		return basis, err
	}
	if head.Digest == "" || checkPolicyHead(state, policyRevision, head) != nil {
		return basis, ErrPolicyConflict
	}
	basis.PolicyRevision, basis.PolicyDigest = head.Draft.Revision, head.Draft.ResultDigest
	basis.Revision, basis.PreviousDigest = 1, original
	err = query.QueryRowContext(ctx, `SELECT revision,digest FROM protected_text_revisions
		WHERE channel_id=? AND position=? ORDER BY revision DESC LIMIT 1`, channel, position).
		Scan(&basis.Revision, &basis.PreviousDigest)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return basis, err
	}
	basis.Revision++
	basis.Recipients, err = revisionLimitedRecipients(state, channel, position)
	return basis, err
}

func revisionLimitedRecipients(state State, channel string, position uint64) ([]RevisionRecipient, error) {
	projection, err := state.TextChannelKeyProjection(channel)
	if err != nil {
		return nil, err
	}
	recipients := []RevisionRecipient{}
	for _, entry := range projection.Recipients {
		if !entry.Archive && state.Admissions[channel][entry.ProfileID].CanRead(position, false) {
			recipients = append(recipients, RevisionRecipient{ID: entry.RecipientID, PublicKey: entry.PublicKey})
		}
	}
	return recipients, nil
}

func (s *Store) DispatchRevisionBasis(ctx context.Context, resolve ResolveSession, verify VerifyEpochRecord, source ResolveRevisionSource,
	channel string, position uint64, scoped *TextChannelPolicyProofCache, deliver func(RevisionBasis) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		original, err := s.authorizeRevision(ctx, conn, state, actor, channel, position, source)
		if err != nil {
			return err
		}
		basis, err := revisionBasis(ctx, conn, state, channel, position, hexHash(original.Signature))
		if err != nil {
			return err
		}
		if err := verify(ctx, conn, basis.Archive.Principal, basis.Archive.Record); err != nil {
			return err
		}
		if scoped != nil {
			head, err := readPolicyHead(ctx, conn)
			if err != nil {
				return err
			}
			if head.Draft.TextProjectionVersion < TextRevisionAudienceVersion {
				return ErrPolicyAttestationUnavailable
			}
			basis.AuthorPolicy, err = textChannelDisclosure(state, head, channel, actor.DeviceID, &scoped.current, position)
			if err != nil {
				return err
			}
			if head.Draft.TextProjectionVersion >= TextGroupedRevisionAudienceProjectionVersion {
				if basis.AuthorPolicy == nil || basis.AuthorPolicy.GroupedAudienceProof == nil {
					return ErrPolicyAttestationUnavailable
				}
				basis.GroupedAudience, err = revisionGroupedAudience(state, head, channel, position, basis.Recipients)
				if err != nil {
					return err
				}
				if head.Draft.Action == EditScopedChannelACLRoleRules {
					basis.RoleViewDeny, err = offlineRoleViewDenyRevisionEvidence(ctx, conn, state, basis, actor, &scoped.history)
				} else {
					basis.PersonalDeny, err = offlineRevisionEvidence(ctx, conn, state, basis, actor, &scoped.history)
				}
				if err != nil {
					return err
				}
			}
			basis.Archive.SigningPolicy, err = historicalTextSigner(ctx, conn, scoped, basis.Archive.Record, basis.Archive.Principal, ArchiveEpoch)
			if err != nil {
				return err
			}
		}
		return deliver(basis)
	})
}

func revisionPackageTree(packages []RevisionPackage, index int) (string, []string, error) {
	leaves := make([][32]byte, len(packages))
	for i, item := range packages {
		fields, err := SignatureFrame("pawtalk-text-revision-package-leaf-v1", item.ID, item.PublicKey, hexHash(item.Ciphertext))
		if err != nil {
			return "", nil, err
		}
		leaves[i] = sha256.Sum256(fields)
	}
	root, siblings := foldCommitmentLeaves(leaves, index)
	return root, siblings, nil
}

func (s *Store) CommitRevision(ctx context.Context, resolve ResolveSession, verifyEpoch VerifyEpochRecord, verify VerifyRevision,
	source ResolveRevisionSource, channel string, position uint64, attempt RevisionAttempt) (RevisionReceipt, error) {
	packet := attempt.Packet
	if !validRotationID(attempt.OperationID) || position == 0 || position >= math.MaxInt64 || attempt.Revision < 2 ||
		attempt.PolicyRevision < 1 || !isDigest(attempt.PolicyDigest) || !isDigest(attempt.PreviousDigest) || !isDigest(attempt.ArchiveDigest) ||
		!isDigest(packet.RecipientDigest) || len(packet.Nonce) != 12 || len(packet.Ciphertext) < 17 || len(packet.Ciphertext) > 12304 ||
		len(packet.Signature) != 64 || len(packet.ArchivePackage) != EpochPackageSize || len(attempt.Packages) > 8192 ||
		!packet.Checklist.valid() {
		return RevisionReceipt{}, InvalidAction
	}
	request, err := json.Marshal(attempt)
	if err != nil {
		return RevisionReceipt{}, err
	}
	frame, err := SignatureFrame(channel, strconv.FormatUint(position, 10), hexHash(request))
	if err != nil {
		return RevisionReceipt{}, err
	}
	requestDigest := hexHash(frame)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RevisionReceipt{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return RevisionReceipt{}, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return RevisionReceipt{}, err
	}
	original, err := s.authorizeRevision(ctx, tx, state, actor, channel, position, source)
	if err != nil {
		return RevisionReceipt{}, err
	}
	if (original.Checklist != nil) != (packet.Checklist != nil) {
		return RevisionReceipt{}, InvalidAction
	}
	var receipt RevisionReceipt
	var seenDigest string
	err = tx.QueryRowContext(ctx, `SELECT request_digest,revision,digest FROM protected_text_revision_receipts
		WHERE operation_id=? AND device_id=?`, attempt.OperationID, actor.DeviceID).Scan(&seenDigest, &receipt.Revision, &receipt.Digest)
	if err == nil {
		if requestDigest != seenDigest {
			return RevisionReceipt{}, ErrRevisionConflict
		}
		receipt.Existing = true
		return receipt, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return RevisionReceipt{}, err
	}
	basis, err := revisionBasis(ctx, tx, state, channel, position, hexHash(original.Signature))
	if err != nil {
		return RevisionReceipt{}, err
	}
	if basis.RevisionExpectation != attempt.RevisionExpectation {
		return RevisionReceipt{}, ErrRevisionConflict
	}
	now := s.now().UnixMilli()
	var recent int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM protected_text_revision_receipts WHERE device_id=? AND created_at>?",
		actor.DeviceID, now-1000).Scan(&recent); err != nil {
		return RevisionReceipt{}, err
	}
	if recent >= 5 {
		return RevisionReceipt{}, ErrMessageRateLimit
	}
	packages := slices.Clone(attempt.Packages)
	slices.SortFunc(packages, func(a, b RevisionPackage) int { return strings.Compare(a.ID, b.ID) })
	if len(packages) != len(basis.Recipients) {
		return RevisionReceipt{}, ErrEpochRecipients
	}
	for i, item := range packages {
		if item.RevisionRecipient != basis.Recipients[i] || len(item.Ciphertext) != EpochPackageSize {
			return RevisionReceipt{}, ErrEpochRecipients
		}
	}
	root, _, err := revisionPackageTree(packages, -1)
	if err != nil {
		return RevisionReceipt{}, err
	}
	if root != packet.RecipientDigest {
		return RevisionReceipt{}, ErrEpochRecipients
	}
	if err := verifyEpoch(ctx, tx, basis.Archive.Principal, basis.Archive.Record); err != nil {
		return RevisionReceipt{}, err
	}
	if err := verify(ctx, tx, actor, channel, basis, attempt); err != nil {
		return RevisionReceipt{}, err
	}
	if packet.Checklist != nil {
		if err := applyChecklistRevision(ctx, tx, channel, position, *original.Checklist, *packet.Checklist); err != nil {
			return RevisionReceipt{}, err
		}
	}
	record := RevisionRecord{RevisionExpectation: basis.RevisionExpectation, Author: actor, Original: basis.Original,
		Archive: basis.Archive, OperationID: attempt.OperationID, EditedAt: now, Packet: packet}
	raw, err := json.Marshal(record)
	if err != nil {
		return RevisionReceipt{}, err
	}
	receipt = RevisionReceipt{Revision: basis.Revision, Digest: hexHash(packet.Signature)}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_text_revisions(channel_id,position,revision,digest,record)
		VALUES(?,?,?,?,?)`, channel, position, receipt.Revision, receipt.Digest, raw); err != nil {
		return RevisionReceipt{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_timeline_changes(cursor,channel_id,position,revision)
		VALUES(?,?,?,?)`, receipt.Digest[:32], channel, position, receipt.Revision); err != nil {
		return RevisionReceipt{}, err
	}
	for _, item := range packages {
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_text_revision_packages(channel_id,position,revision,recipient_id,public_key,ciphertext)
			VALUES(?,?,?,?,?,?)`, channel, position, receipt.Revision, item.ID, item.PublicKey, item.Ciphertext); err != nil {
			return RevisionReceipt{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_text_revision_receipts(device_id,operation_id,request_digest,revision,digest,created_at)
		VALUES(?,?,?,?,?,?)`, actor.DeviceID, attempt.OperationID, requestDigest, receipt.Revision, receipt.Digest, now); err != nil {
		return RevisionReceipt{}, err
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "message.edit", Kind: "message",
		ObjectID: strconv.FormatUint(position, 10), ChannelID: channel, Position: position}); err != nil {
		return RevisionReceipt{}, err
	}
	if err := s.enforceStorageRetention(ctx, tx, storagePosition{channel, position}); err != nil {
		return RevisionReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return RevisionReceipt{}, err
	}
	return receipt, nil
}
