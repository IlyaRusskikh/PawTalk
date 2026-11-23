package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

const migrationFixtureLegacySecret = "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5"

func TestProtectedMigrationHistoryProofExpiresAndIsConsumedOnce(t *testing.T) {
	store, clock, owner, _, _, _ := testMigrationHistoryHTTPSource(t, t.TempDir(), "manual")
	handler := newProtectedMigrationHandler(store, nil)
	server := httptest.NewTLSServer(handler)
	defer server.Close()
	issue := func() migrationHistoryChallenge {
		t.Helper()
		response, err := server.Client().Get(server.URL + "/api/v3/migration/challenge")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var challenge migrationHistoryChallenge
		if err := json.NewDecoder(response.Body).Decode(&challenge); err != nil || response.StatusCode != http.StatusOK || challenge.Nonce == "" {
			t.Fatalf("failed to issue challenge: %+v, %v", challenge, err)
		}
		return challenge
	}
	prepare := func(challenge migrationHistoryChallenge) []byte {
		t.Helper()
		proof := migrationHistoryProof{Nonce: challenge.Nonce, DeviceID: publicKeyID(owner.device.Public().(ed25519.PublicKey)), Limit: 1}
		frame, err := migrationHistoryProofFrame(challenge.ServerID, "messages", proof)
		if err != nil {
			t.Fatal(err)
		}
		proof.Signature = b64.EncodeToString(ed25519.Sign(owner.device, frame))
		body, err := json.Marshal(proof)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	post := func(body []byte) (int, error) {
		response, err := server.Client().Post(server.URL+"/api/v3/migration/history/messages/page", "application/json", bytes.NewReader(body))
		if err != nil {
			return 0, err
		}
		defer response.Body.Close()
		return response.StatusCode, nil
	}
	expired := issue()
	clock.Store(expired.ExpiresAt)
	if status, err := post(prepare(expired)); err != nil || status != http.StatusUnauthorized {
		t.Fatalf("expired challenge: status %d, %v", status, err)
	}
	body := prepare(issue())
	statuses := make(chan int, 2)
	for range 2 {
		go func() {
			status, err := post(body)
			if err != nil {
				t.Error(err)
			}
			statuses <- status
		}()
	}
	first, second := <-statuses, <-statuses
	if !((first == http.StatusOK && second == http.StatusUnauthorized) || (second == http.StatusOK && first == http.StatusUnauthorized)) {
		t.Fatalf("concurrent use of one challenge produced statuses %d and %d", first, second)
	}
	plain := httptest.NewRecorder()
	handler.ServeHTTP(plain, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/v3/migration/challenge", nil))
	if plain.Code != http.StatusUpgradeRequired {
		t.Fatalf("migration challenge on an unencrypted transport: %d", plain.Code)
	}
}

func TestProtectedMigrationHistoryTLSClient(t *testing.T) {
	ctx := t.Context()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	dir := t.TempDir()
	store, _, owner, admin, revoked, report := testMigrationHistoryHTTPSource(t, dir, "manual")
	openStaging := func() *membershipStore {
		t.Helper()
		db, err := openMigrationImportDatabase(filepath.Join(dir, membershipDatabaseFile))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		return &membershipStore{db: db, now: store.now}
	}
	writer := openStaging()
	server := httptest.NewTLSServer(newProtectedMigrationHandler(store, writer))
	defer server.Close()
	seeds := func(signer testMemberSigner) map[string]string {
		return map[string]string{"root": hex.EncodeToString(signer.root.Seed()), "device": hex.EncodeToString(signer.device.Seed())}
	}
	certificate := server.Certificate()
	fixture := map[string]any{
		"base": server.URL, "serverId": report.ServerID, "archiveSha256": report.BackupArchiveSHA256,
		"legacySecret": migrationFixtureLegacySecret,
		"certificate":  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})),
		"owner":        seeds(owner), "admin": seeds(admin), "revoked": seeds(revoked),
		"legacyBanned": seeds(newTestMemberSigner(5)), "legacyBannedAlias": seeds(newTestMemberSigner(6)),
	}
	input, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-migration-history-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	output, err := runMigrationClient(ctx, node, script, input)
	if err != nil {
		t.Fatalf("migration history TLS integration: %v\n%s", err, output)
	}
	var packets struct {
		Migrated, Retry, NextPacket, AttachmentPacket migratedHistoryPacket
		PackageReceipt                                migrationRecoveryArchiveReceipt
		TestRecoveryCode                              string `json:"testRecoveryCode"`
		TestArchiveSecret                             string `json:"testArchiveSecret"`
	}
	if err := json.Unmarshal(output, &packets); err != nil {
		t.Fatal(err)
	}
	tampered := packets.NextPacket
	tampered.Metadata = []byte(`{"messageId":"1"}`)
	if _, err := writer.stageMigratedHistoryRecord(ctx, tampered); err == nil || err.Error() != "INVALID_MIGRATION_PACKET" {
		t.Fatalf("import accepted altered source metadata: %v", err)
	}
	if _, err := writer.db.Exec(`CREATE TRIGGER reject_migrated_record BEFORE INSERT ON protected_migration_records
		BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if receipt, err := writer.stageMigratedHistoryRecord(ctx, packets.NextPacket); err == nil || receipt.CiphertextSHA256 != "" {
		t.Fatalf("storage failure returned a receipt: %+v, %v", receipt, err)
	}
	var recordCount int
	if err := writer.db.QueryRow("SELECT COUNT(*) FROM protected_migration_records").Scan(&recordCount); err != nil || recordCount != 1 {
		t.Fatalf("failed record affected durable progress: %d, %v", recordCount, err)
	}
	if _, err := writer.db.Exec("DROP TRIGGER reject_migrated_record"); err != nil {
		t.Fatal(err)
	}
	receipt, err := writer.stageMigratedHistoryRecord(ctx, packets.Migrated)
	if err != nil || receipt.ID != packets.Migrated.ID || receipt.CiphertextSHA256 != publicKeyID(packets.Migrated.Ciphertext) {
		t.Fatalf("Go could not import the packet produced by Electron: %+v, %v", receipt, err)
	}
	if err := writer.db.Close(); err != nil {
		t.Fatal(err)
	}
	writer = openStaging()
	recovery := packets.PackageReceipt
	var persistedPackage []byte
	if err := writer.db.QueryRow(`SELECT ciphertext FROM protected_migration_recovery_packages
		WHERE channel_id=? AND key_id=? AND recovery_id=?`, recovery.ChannelID, recovery.KeyID, recovery.RecoveryID).
		Scan(&persistedPackage); err != nil || publicKeyID(persistedPackage) != recovery.CiphertextSHA256 {
		t.Fatalf("committed recovery package did not match its receipt after reopen: %v", err)
	}
	if retry, err := writer.stageMigratedHistoryRecord(ctx, packets.Retry); err != nil || retry != receipt || bytes.Equal(packets.Retry.Ciphertext, packets.Migrated.Ciphertext) {
		t.Fatalf("a new crypto attempt replaced the first committed packet: %+v, %v", retry, err)
	}
	var persisted []byte
	if err := writer.db.QueryRow("SELECT ciphertext FROM protected_migration_records WHERE kind='messages' AND source_id=?", receipt.ID).
		Scan(&persisted); err != nil || !bytes.Equal(persisted, packets.Migrated.Ciphertext) {
		t.Fatalf("committed ciphertext changed: %v", err)
	}
	if _, err := writer.stageMigratedHistoryRecord(ctx, packets.NextPacket); err != nil {
		t.Fatal(err)
	}
	releasePages := limitMigrationDatabasePages(t, writer.db)
	attachmentReceipt, err := writer.stageMigratedHistoryRecord(ctx, packets.AttachmentPacket)
	requireMigrationSQLiteFull(t, err)
	if attachmentReceipt != (migrationImportReceipt{}) {
		t.Fatalf("full disk returned a successful attachment receipt: %+v", attachmentReceipt)
	}
	releasePages()
	if err := writer.db.QueryRow(`SELECT COUNT(*) FROM protected_migration_records`).Scan(&recordCount); err != nil || recordCount != 2 {
		t.Fatalf("full disk changed committed import progress: %d, %v", recordCount, err)
	}
	if report, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256); err == nil || report.History.Records == 3 {
		t.Fatalf("partial import passed verification: %+v, %v", report.History, err)
	}
	if _, err := writer.stageMigratedHistoryRecord(ctx, packets.AttachmentPacket); err != nil {
		t.Fatal(err)
	}
	verified, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256)
	if err != nil || verified.History.Records != 3 || !validHexID(verified.History.Digest, 64) ||
		!validHexID(verified.PolicyDigest, 64) || len(verified.PolicyBlockers) != 0 ||
		!validHexID(verified.MessagePositionsDigest, 64) ||
		!validHexID(verified.RecoveryArchiveDigest, 64) || verified.RecoveryArchive.ConfirmedPackages != 1 ||
		!validHexID(verified.ReviewDigest, 64) {
		t.Fatalf("staged import verification: %+v, %v", verified, err)
	}
	if repeated, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256); err != nil ||
		repeated.History != verified.History || repeated.RecoveryArchiveDigest != verified.RecoveryArchiveDigest ||
		repeated.PolicyDigest != verified.PolicyDigest || repeated.MessagePositionsDigest != verified.MessagePositionsDigest ||
		repeated.ReviewDigest != verified.ReviewDigest {
		t.Fatalf("commitments changed with identical data: %+v, %v", repeated, err)
	}
	fixture["review"] = verified
	reviewInput, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	approval, err := runMigrationClient(ctx, node, script, reviewInput)
	if err != nil {
		t.Fatalf("Client signing failed: %v\n%s", err, approval)
	}
	recipientServer := httptest.NewTLSServer(newProtectedMigrationHandler(store, writer))
	defer recipientServer.Close()
	fixture["base"] = recipientServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: recipientServer.Certificate().Raw}))
	enrollRecipient := func(phase string) []byte {
		t.Helper()
		fixture["recipient"] = phase
		raw, err := json.Marshal(fixture)
		if err != nil {
			t.Fatal(err)
		}
		output, err := runMigrationClient(ctx, node, script, raw)
		if err != nil {
			t.Fatalf("recipient enrollment %s: %v\n%s", phase, err, output)
		}
		return output
	}
	enrollRecipient("before-approval")
	approve := func(input []byte) (migrationImportApprovalReceipt, error) {
		return approveStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256, bytes.NewReader(input))
	}
	changed := migrationImportApproval{
		ReviewDigest: publicKeyID([]byte("older signed review")),
		DeviceID:     publicKeyID(owner.device.Public().(ed25519.PublicKey)),
	}
	frame, err := signatureFrame("pawtalk-migration-import-approval-v1", report.ServerID, report.BackupArchiveSHA256,
		report.OwnerProfileID, changed.DeviceID, changed.ReviewDigest)
	if err != nil {
		t.Fatal(err)
	}
	changed.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(owner.device, frame))
	stale, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	if recorded, err := approve(stale); err == nil || err.Error() != "MIGRATION_IMPORT_REVIEW_CHANGED" || recorded.ReviewDigest != "" {
		t.Fatalf("stale review was accepted: %+v, %v", recorded, err)
	}
	approved, err := approve(approval)
	if err != nil || approved.ReviewDigest != verified.ReviewDigest || approved.DeviceID != changed.DeviceID {
		t.Fatalf("Client approval was rejected: %+v, %v", approved, err)
	}
	if retry, err := approve(approval); err != nil || retry != approved {
		t.Fatalf("approval did not converge on retry: %+v, %v", retry, err)
	}
	var recipientFixture struct {
		Receipt           migrationRecipientReceipt `json:"receipt"`
		TestAgreementSeed string                    `json:"testAgreementSeed"`
	}
	if err := json.Unmarshal(enrollRecipient("after-approval"), &recipientFixture); err != nil {
		t.Fatal(err)
	}
	enrolled := recipientFixture.Receipt
	if enrolled.ReviewDigest != approved.ReviewDigest || enrolled.DeviceID != approved.DeviceID || !validHexID(enrolled.PublicKey, 64) {
		t.Fatalf("unexpected enrolled recipient: %+v", enrolled)
	}
	current, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256)
	if err != nil || current.ReviewDigest != verified.ReviewDigest || current.OwnerRecipient == nil ||
		*current.OwnerRecipient != enrolled || current.InitialPolicy == nil ||
		current.InitialPolicy.Draft.TextProjectionVersion != access.ProfileRoleAuthorityProjectionVersion ||
		!current.InitialPolicy.PreserveChannelOrder || !current.InitialPolicy.RuntimeRecovery {
		t.Fatalf("verified import did not include durable recipient proof: %+v, %v", current, err)
	}
	rows, err := writer.db.QueryContext(ctx, "SELECT channel_id FROM channels ORDER BY position,channel_id")
	if err != nil {
		t.Fatal(err)
	}
	var ordered []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		ordered = append(ordered, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	var initial access.State
	if err := json.Unmarshal(current.InitialPolicy.Snapshot, &initial); err != nil || len(ordered) < 2 ||
		!slices.Equal(initial.ChannelOrder, ordered) {
		t.Fatalf("initial channel order %v differs from API 2 %v: %v", initial.ChannelOrder, ordered, err)
	}
	if enrolledRecovery := initial.RecoveryIdentities[current.OwnerProfileID]; enrolledRecovery.ID != recovery.RecoveryID ||
		!validHexID(enrolledRecovery.SigningKey, 64) || !validHexID(enrolledRecovery.AgreementKey, 64) || !initial.RecoveryReady[current.OwnerProfileID] {
		t.Fatal("migration genesis did not adopt the reviewed owner recovery identity")
	}
	if _, err := writer.db.Exec("UPDATE protected_migration_message_positions SET position=5 WHERE message_id=9007199254740991"); err != nil {
		t.Fatal(err)
	}
	if retry, err := approve(approval); err == nil || err.Error() != "MIGRATION_INVALID_MESSAGE_POSITION" || retry.ReviewDigest != "" {
		t.Fatalf("approval accepted an index that disagreed with the signed report: %+v, %v", retry, err)
	}
	if _, err := writer.db.Exec("UPDATE protected_migration_message_positions SET position=1 WHERE message_id=9007199254740991"); err != nil {
		t.Fatal(err)
	}
	tx, err := writer.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SAVEPOINT legacy_projection;
		ALTER TABLE protected_migration_text_projection_seed DROP COLUMN runtime_recovery;
		UPDATE protected_migration_text_projection_seed SET projection_version=7`); err != nil {
		t.Fatal(err)
	}
	priorV7, err := writer.readVerifiedMigrationImport(ctx, tx, dir, report.BackupArchiveSHA256)
	if err != nil || priorV7.InitialPolicy == nil || !priorV7.InitialPolicy.PreserveChannelOrder || priorV7.InitialPolicy.RuntimeRecovery ||
		priorV7.InitialPolicy.Draft.TextProjectionVersion != access.TextOrderAuthorityVersion ||
		priorV7.InitialPolicy.Draft.ResultDigest == current.InitialPolicy.Draft.ResultDigest ||
		priorV7.InitialPolicy.Draft.TextProjectionRoot == current.InitialPolicy.Draft.TextProjectionRoot ||
		priorV7.ReviewDigest != current.ReviewDigest {
		t.Fatalf("prior v7 staged migration did not retain its format: %v", err)
	}
	if _, err := tx.ExecContext(ctx, `
		ALTER TABLE protected_migration_text_projection_seed DROP COLUMN preserve_channel_order;
		UPDATE protected_migration_text_projection_seed SET projection_version=3`); err != nil {
		t.Fatal(err)
	}
	priorV3, err := writer.readVerifiedMigrationImport(ctx, tx, dir, report.BackupArchiveSHA256)
	if err != nil || priorV3.InitialPolicy == nil || priorV3.InitialPolicy.PreserveChannelOrder ||
		priorV3.InitialPolicy.Draft.TextProjectionVersion != access.TextRecipientProjectionVersion ||
		priorV3.InitialPolicy.Draft.ResultDigest == current.InitialPolicy.Draft.ResultDigest ||
		priorV3.InitialPolicy.Draft.TextProjectionRoot == current.InitialPolicy.Draft.TextProjectionRoot ||
		priorV3.ReviewDigest != current.ReviewDigest {
		t.Fatalf("prior v3 staged migration did not retain its format: %v", err)
	}
	if _, err := tx.ExecContext(ctx, `
		ALTER TABLE protected_migration_text_projection_seed DROP COLUMN projection_version`); err != nil {
		t.Fatal(err)
	}
	legacyProjection, err := writer.readVerifiedMigrationImport(ctx, tx, dir, report.BackupArchiveSHA256)
	if err != nil || legacyProjection.InitialPolicy == nil || legacyProjection.InitialPolicy.Draft.TextProjectionVersion != 0 ||
		legacyProjection.InitialPolicy.Draft.TextProjectionSeed != current.InitialPolicy.Draft.TextProjectionSeed ||
		legacyProjection.InitialPolicy.Draft.TextProjectionRoot == priorV3.InitialPolicy.Draft.TextProjectionRoot ||
		legacyProjection.InitialPolicy.Draft.ResultDigest != priorV3.InitialPolicy.Draft.ResultDigest {
		t.Fatalf("projection format changed for a legacy staged migration: %v", err)
	}
	if _, err := tx.ExecContext(ctx, "ROLLBACK TO legacy_projection; RELEASE legacy_projection"); err != nil {
		t.Fatal(err)
	}
	progress, err := readMigrationImportProgress(ctx, tx)
	if err != nil || !progress.Complete || progress.Counts["messages"] != (migrationImportCount{Source: 2, Imported: 2}) {
		t.Fatalf("complete set was rejected: %+v, %v", progress, err)
	}
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	if stored, err := writer.readValidMigrationOwnerRecipient(ctx, tx, authority); err != nil || stored != enrolled {
		t.Fatalf("recipient stored proof failed validation: %+v, %v", stored, err)
	}
	if _, err := tx.ExecContext(ctx, `SAVEPOINT damaged_import;
		UPDATE protected_migration_records SET ciphertext=zeroblob(length(ciphertext)) WHERE kind='messages'`); err != nil {
		t.Fatal(err)
	}
	if result, err := writer.verifyMigrationHistory(ctx, tx, authority); err == nil ||
		err.Error() != "MIGRATION_STAGED_HISTORY_MISMATCH" || result.Digest != "" {
		t.Fatalf("verification accepted corrupted ciphertext: %+v, %v", result, err)
	}
	if _, err := tx.ExecContext(ctx, `ROLLBACK TO damaged_import; RELEASE damaged_import;
		UPDATE protected_migration_recovery_packages SET confirmation=zeroblob(64)`); err != nil {
		t.Fatal(err)
	}
	policy, err := readMigrationPolicyDraft(ctx, tx, authority)
	if err != nil {
		t.Fatal(err)
	}
	if digest, err := writer.verifyMigrationRecoveryArchives(ctx, tx, authority, policy); err == nil || digest != "" {
		t.Fatalf("verification accepted invalid recovery confirmation: %q, %v", digest, err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_migration_records SET source_id='1' WHERE kind='messages' AND source_id=?", receipt.ID); err != nil {
		t.Fatal(err)
	}
	progress, err = readMigrationImportProgress(ctx, tx)
	if err != nil || progress.Complete || progress.Counts["messages"] != (migrationImportCount{Source: 2, Imported: 1}) {
		t.Fatalf("equal totals with the wrong source IDs passed: %+v, %v", progress, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	testImportedHistorySnapshot(t, ctx, writer, report.OwnerProfileID, recovery.ChannelID, packets.Migrated, packets.NextPacket)
	fixture["review"], fixture["testAgreementSeed"] = current, recipientFixture.TestAgreementSeed
	signedPolicy := enrollRecipient("sign-policy")
	badPolicy := migrationPolicyApproval{ReviewDigest: current.ReviewDigest}
	invalidDraft := current.InitialPolicy.Draft
	invalidDraft.Signature = make([]byte, ed25519.SignatureSize)
	badPolicy.PolicySignature = base64.RawURLEncoding.EncodeToString(invalidDraft.Signature)
	bindingFrame, err := migrationPolicyBindingFrame(authority, current, invalidDraft)
	if err != nil {
		t.Fatal(err)
	}
	badPolicy.ImportBinding = base64.RawURLEncoding.EncodeToString(ed25519.Sign(owner.device, bindingFrame))
	invalidApproval, err := json.Marshal(badPolicy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stageStandaloneMigrationPolicy(ctx, dir, report.BackupArchiveSHA256, bytes.NewReader(invalidApproval)); err == nil ||
		err.Error() != "INVALID_POLICY_SIGNATURE" {
		t.Fatalf("invalid policy signature passed staging: %v", err)
	}
	var badScope migrationPolicyApproval
	if err := json.Unmarshal(signedPolicy, &badScope); err != nil || badScope.ScopeAttestation == "" {
		t.Fatalf("missing signed scope attestation in migration approval: %v", err)
	}
	badScope.ScopeAttestation = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	invalidScope, err := json.Marshal(badScope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stageStandaloneMigrationPolicy(ctx, dir, report.BackupArchiveSHA256, bytes.NewReader(invalidScope)); err == nil ||
		err.Error() != "INVALID_POLICY_ATTESTATION" {
		t.Fatalf("invalid scope attestation passed staging: %v", err)
	}
	var policyPersisted bool
	if err := writer.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_policy')").
		Scan(&policyPersisted); err != nil || policyPersisted {
		t.Fatalf("failed staging created durable policy: %t, %v", policyPersisted, err)
	}
	proof, err := stageStandaloneMigrationPolicy(ctx, dir, report.BackupArchiveSHA256, bytes.NewReader(signedPolicy))
	if err != nil || proof.Draft.Revision != 1 || proof.Principal.DeviceID != enrolled.DeviceID ||
		proof.Draft.ResultDigest != current.InitialPolicy.Draft.ResultDigest {
		t.Fatalf("initial policy staging failed: %+v, %v", proof, err)
	}
	if repeat, err := stageStandaloneMigrationPolicy(ctx, dir, report.BackupArchiveSHA256, bytes.NewReader(signedPolicy)); err != nil ||
		repeat.Digest != proof.Digest {
		t.Fatalf("initial policy staging did not converge: %+v, %v", repeat, err)
	}
	final, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256)
	if err != nil || final.PolicyAnchorDigest != proof.Digest || final.CutoverDigest != "" {
		t.Fatalf("report did not verify staged anchor: %+v, %v", final, err)
	}
	approveCutover := func(input []byte) (migrationCutoverReceipt, error) {
		return approveStandaloneMigrationCutover(ctx, dir, report.BackupArchiveSHA256, bytes.NewReader(input))
	}
	fakeCutover, err := json.Marshal(migrationCutoverApproval{
		CutoverDigest: publicKeyID([]byte("incomplete cutover")), Signature: base64.RawURLEncoding.EncodeToString(make([]byte, 64)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := approveCutover(fakeCutover); err == nil || err.Error() != "MIGRATION_CUTOVER_NOT_READY" {
		t.Fatalf("cutover was available without required material: %v", err)
	}
	var policyApproval migrationPolicyApproval
	if err := json.Unmarshal(signedPolicy, &policyApproval); err != nil {
		t.Fatal(err)
	}
	fixture["review"], fixture["policyApproval"], fixture["keyChannelId"] = final, policyApproval, recovery.ChannelID
	fixture["testRecoveryCode"] = packets.TestRecoveryCode
	fixture["testArchiveSecret"] = packets.TestArchiveSecret
	var interruptedKeys map[string]string
	if err := json.Unmarshal(enrollRecipient("prepare-keys-before-restart"), &interruptedKeys); err != nil {
		t.Fatal(err)
	}
	var liveKeyID, liveDigest string
	if err := writer.db.QueryRow(`SELECT key_id,digest FROM protected_epochs WHERE channel_id=? AND purpose='live' AND generation=1`,
		recovery.ChannelID).Scan(&liveKeyID, &liveDigest); err != nil || liveKeyID != interruptedKeys["live"] || !validHexID(liveDigest, 64) {
		t.Fatalf("interrupted live epoch was not durable: %q %q, %v", liveKeyID, liveDigest, err)
	}
	var archiveCount int
	if err := writer.db.QueryRow(`SELECT COUNT(*) FROM protected_epochs WHERE channel_id=? AND purpose='archive'`,
		recovery.ChannelID).Scan(&archiveCount); err != nil || archiveCount != 0 {
		t.Fatalf("archive epoch completed before restart: %d, %v", archiveCount, err)
	}
	if checkpoint, err := inspectProtectedMigration(ctx, filepath.Join(dir, membershipDatabaseFile), time.Now()); err != nil || !checkpoint.Maintenance {
		t.Fatalf("interrupted preparation left maintenance: %+v, %v", checkpoint, err)
	}
	if _, err := approveCutover(fakeCutover); err == nil || err.Error() != "MIGRATION_CUTOVER_NOT_READY" {
		t.Fatalf("partially prepared epochs allowed cutover: %v", err)
	}

	recipientServer.Close()
	if err := writer.db.Close(); err != nil {
		t.Fatal(err)
	}
	writer = openStaging()
	resumedServer := httptest.NewTLSServer(newProtectedMigrationHandler(store, writer))
	defer resumedServer.Close()
	fixture["base"] = resumedServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: resumedServer.Certificate().Raw}))
	fixture["testFirstLiveKeyId"] = liveKeyID
	var keys map[string]string
	if err := json.Unmarshal(enrollRecipient("prepare-keys"), &keys); err != nil {
		t.Fatal(err)
	}
	var resumedLiveKeyID, resumedLiveDigest string
	if err := writer.db.QueryRow(`SELECT key_id,digest FROM protected_epochs WHERE channel_id=? AND purpose='live' AND generation=1`,
		recovery.ChannelID).Scan(&resumedLiveKeyID, &resumedLiveDigest); err != nil || resumedLiveKeyID != liveKeyID || resumedLiveDigest != liveDigest {
		t.Fatalf("resume replaced the committed live epoch: %q %q, %v", resumedLiveKeyID, resumedLiveDigest, err)
	}
	for _, purpose := range []string{access.LiveEpoch, access.ArchiveEpoch} {
		var key string
		err := writer.db.QueryRow("SELECT key_id FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=1",
			recovery.ChannelID, purpose).Scan(&key)
		if err != nil || !validHexID(key, 64) || key != keys[purpose] {
			t.Fatalf("missing committed %s epoch: %q, %v", purpose, key, err)
		}
	}
	completed, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256)
	if err != nil || completed.CurrentRecovery == nil || completed.CurrentRecovery.Expected != 2 ||
		completed.CurrentRecovery.Confirmed != 2 || !validHexID(completed.CurrentRecovery.Digest, 64) ||
		completed.PolicyAnchorDigest != final.PolicyAnchorDigest {
		t.Fatalf("current recovery did not verify: %+v, %v", completed.CurrentRecovery, err)
	}
	if completed.HistoryLinks == nil || completed.HistoryLinks.Expected != 1 || completed.HistoryLinks.Confirmed != 1 ||
		!validHexID(completed.HistoryLinks.Digest, 64) || !validHexID(completed.CutoverDigest, 64) {
		t.Fatalf("history link coverage: %+v", completed.HistoryLinks)
	}
	if _, err := activateStandaloneProtectedRuntime(ctx, dir, report.BackupArchiveSHA256); err == nil ||
		err.Error() != "MIGRATION_CUTOVER_APPROVAL_REQUIRED" {
		t.Fatalf("protected runtime opened without cutover approval: %v", err)
	}
	ownerResolver := func(context.Context, access.SessionQuery) (access.Principal, error) { return proof.Principal, nil }
	var delivered migrationHistoryLinkDelivery
	err = writer.dispatchMigrationHistoryLink(ctx, ownerResolver, recovery.ChannelID, func(link migrationHistoryLinkDelivery) error {
		delivered = link
		return nil
	})
	if err != nil || delivered.Link == nil || delivered.ArchiveKeyID != keys[access.ArchiveEpoch] ||
		delivered.ImportedKeyID != packets.Migrated.KeyID {
		t.Fatalf("owner did not receive the original history link: %+v, %v", delivered, err)
	}
	otherResolver := func(context.Context, access.SessionQuery) (access.Principal, error) {
		return access.Principal{ProfileID: proof.Principal.ProfileID, DeviceID: publicKeyID(admin.device.Public().(ed25519.PublicKey))}, nil
	}
	err = writer.dispatchMigrationHistoryLink(ctx, otherResolver, recovery.ChannelID, func(migrationHistoryLinkDelivery) error {
		t.Fatal("unenrolled device received the archived history link")
		return nil
	})
	if err != access.Inactive && err != access.ChannelRestricted {
		t.Fatalf("unenrolled device did not receive authorization refusal: %v", err)
	}
	badBackup, err := writer.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer badBackup.Rollback()
	if _, err := badBackup.ExecContext(ctx, "UPDATE protected_migration_recovery_epochs SET confirmation=zeroblob(64) WHERE purpose='live'"); err != nil {
		t.Fatal(err)
	}
	enrollment, err := readMigrationRecoveryEnrollment(ctx, badBackup, authority.ownerID)
	if err != nil || enrollment == nil {
		t.Fatalf("read enrollment for backup test: %v", err)
	}
	if coverage, err := writer.verifyMigrationEpochRecovery(ctx, badBackup, authority, proof.Digest, proof.Principal, *enrollment); err == nil || coverage.Digest != "" {
		t.Fatalf("corrupt confirmation passed recovery verification: %+v, %v", coverage, err)
	}
	if err := badBackup.Rollback(); err != nil {
		t.Fatal(err)
	}
	badOpening, err := writer.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer badOpening.Rollback()
	if _, err := badOpening.ExecContext(ctx, "UPDATE protected_migration_runtime_recovery SET opening_proof=zeroblob(64) WHERE purpose='archive'"); err != nil {
		t.Fatal(err)
	}
	if coverage, err := writer.verifyMigrationEpochRecovery(ctx, badOpening, authority, proof.Digest, proof.Principal, *enrollment); err == nil ||
		err.Error() != "INVALID_MIGRATION_RUNTIME_RECOVERY_PROOF" || coverage.Digest != "" {
		t.Fatalf("corrupt runtime opening passed cutover coverage: %+v, %v", coverage, err)
	}
	if err := badOpening.Rollback(); err != nil {
		t.Fatal(err)
	}
	fixture["review"] = completed
	cutoverProof := enrollRecipient("sign-cutover")
	if _, err := approveCutover(fakeCutover); err == nil || err.Error() != "MIGRATION_CUTOVER_CHANGED" {
		t.Fatalf("stale cutover commitment passed: %v", err)
	}
	tx, err = writer.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE protected_epoch_packages SET ciphertext=zeroblob(80)
		WHERE channel_id=? AND purpose='live' AND generation=1`, recovery.ChannelID); err != nil {
		t.Fatal(err)
	}
	if current, err := writer.readVerifiedMigrationImport(ctx, tx, dir, report.BackupArchiveSHA256); err == nil || current.CutoverDigest != "" {
		t.Fatalf("corrupted live device package passed: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var suppliedCutover migrationCutoverApproval
	if err := json.Unmarshal(cutoverProof, &suppliedCutover); err != nil || suppliedCutover.ScopeAuthority == nil {
		t.Fatalf("fresh migration cutover did not receive detached genesis authority: %v", err)
	}
	withoutAuthority := suppliedCutover
	withoutAuthority.ScopeAuthority = nil
	badAuthority := *suppliedCutover.ScopeAuthority
	badAuthority.PolicyHead = publicKeyID([]byte("wrong policy anchor"))
	withWrongHead := suppliedCutover
	withWrongHead.ScopeAuthority = &badAuthority
	for _, invalid := range []migrationCutoverApproval{withoutAuthority, withWrongHead} {
		payload, err := json.Marshal(invalid)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := approveCutover(payload); err == nil || err.Error() != "INVALID_MIGRATION_CUTOVER_APPROVAL" {
			t.Fatalf("fresh migration accepted cutover without verified genesis authority: %v", err)
		}
	}
	cutover, err := approveCutover(cutoverProof)
	if err != nil || cutover.CutoverDigest != completed.CutoverDigest || cutover.DeviceID != enrolled.DeviceID {
		t.Fatalf("cutover approval failed: %+v, %v", cutover, err)
	}
	if repeated, err := approveCutover(cutoverProof); err != nil || repeated != cutover {
		t.Fatalf("cutover repeat did not converge: %+v, %v", repeated, err)
	}
	retryServer := httptest.NewTLSServer(newProtectedMigrationHandler(store, writer))
	defer retryServer.Close()
	fixture["base"] = retryServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: retryServer.Certificate().Raw}))
	if repeated := enrollRecipient("sign-cutover"); !bytes.Equal(repeated, cutoverProof) {
		t.Fatal("maintenance client changed an already-recorded cutover approval")
	}
	if status, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256); err != nil || status.CutoverApproval == nil || *status.CutoverApproval != cutover {
		t.Fatalf("cutover approval was not verifiable after reopen: %+v, %v", status.CutoverApproval, err)
	}
	if checkpoint, err := inspectProtectedMigration(ctx, filepath.Join(dir, membershipDatabaseFile), time.Now()); err != nil || !checkpoint.Maintenance {
		t.Fatalf("approval changed the schema: %+v, %v", checkpoint, err)
	}
	if _, err := writer.db.Exec("CREATE TABLE protected_runtime_sessions (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if _, err := activateStandaloneProtectedRuntime(ctx, dir, report.BackupArchiveSHA256); err == nil {
		t.Fatal("activation passed an injected schema failure")
	}
	var version int
	var marker bool
	if err := writer.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != membershipMigrationSchemaVersion {
		t.Fatalf("failed activation changed the schema version: %d, %v", version, err)
	}
	if err := writer.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_runtime_activation')").Scan(&marker); err != nil || marker {
		t.Fatalf("failed activation kept the new marker: %t, %v", marker, err)
	}
	if _, err := writer.db.Exec("DROP TABLE protected_runtime_sessions"); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.db.Exec("VACUUM"); err != nil {
		t.Fatal(err)
	}
	releasePages = limitMigrationDatabasePages(t, writer.db)
	failedActivation, err := activateProtectedRuntime(ctx, writer.db, dir, report.BackupArchiveSHA256)
	requireMigrationSQLiteFull(t, err)
	if failedActivation != (protectedActivation{}) {
		t.Fatalf("full disk returned a successful activation: %+v", failedActivation)
	}
	releasePages()
	if err := writer.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != membershipMigrationSchemaVersion {
		t.Fatalf("full disk changed the schema version: %d, %v", version, err)
	}
	if err := writer.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_runtime_activation')").Scan(&marker); err != nil || marker {
		t.Fatalf("full disk kept a partial activation marker: %t, %v", marker, err)
	}
	if status, err := verifyStandaloneMigrationImport(ctx, dir, report.BackupArchiveSHA256); err != nil ||
		status.CutoverApproval == nil || *status.CutoverApproval != cutover {
		t.Fatalf("full disk invalidated the approved checkpoint: %+v, %v", status.CutoverApproval, err)
	}
	activation, err := activateStandaloneProtectedRuntime(ctx, dir, report.BackupArchiveSHA256)
	if err != nil || activation.CutoverDigest != cutover.CutoverDigest {
		t.Fatalf("runtime activation: %+v, %v", activation, err)
	}
	if _, err := openMembershipStore(filepath.Join(dir, membershipDatabaseFile)); err == nil {
		t.Fatal("API 2 accepted the activated data")
	}
	if _, err := readMigrationAuthority(ctx, writer.db); err == nil || err.Error() != "MIGRATION_UNAVAILABLE" {
		t.Fatalf("maintenance writer still authorized after activation: %v", err)
	}
	var legacySessions int
	if err := writer.db.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&legacySessions); err != nil {
		t.Fatal(err)
	}
	// Emulate a database already activated by a build that still read
	// the name directly from the frozen source.
	if _, err := writer.db.ExecContext(ctx, "DROP TABLE protected_community_name"); err != nil {
		t.Fatal(err)
	}
	runtime, err := openProtectedRuntime(ctx, writer, dir, report.BackupArchiveSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if community, err := access.ReadCommunityName(ctx, writer.db); err != nil || community.Name == "" {
		t.Fatalf("protected runtime failed to load the imported name after upgrade: %+v, %v", community, err)
	}
	recoveryDir := t.TempDir()
	stateBytes, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(recoveryDir, "state.json"), stateBytes, 0600); err != nil {
		t.Fatal(err)
	}
	recoveryDBPath := filepath.Join(recoveryDir, membershipDatabaseFile)
	if _, err := writer.db.ExecContext(ctx, "VACUUM INTO ?", recoveryDBPath); err != nil {
		t.Fatal(err)
	}
	t.Run("restored runtime rejects known policy rollback", func(t *testing.T) {
		copyFixture := maps.Clone(fixture)
		copyFixture["policyProof"] = proof
		testProtectedMigrationRestoredBackup(t, ctx, writer, stateBytes, node, script, report.BackupArchiveSHA256, copyFixture)
	})
	// The fixture compresses a migration review and several subsequent
	// conversations into one clock tick. Keep its history exercises in a
	// separate rate bucket without changing the production limiter.
	runtimeHandler, revisionHandler, historyWindowHandler := runtime.handler(), runtime.handler(), runtime.handler()
	liveTimelineHandler, importedTimelineHandler := runtime.handler(), runtime.handler()
	attachmentHandler := runtime.handler()
	keyHandler := runtime.handler()
	runtimeServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v3/keys/") {
			keyHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/live-attachments/") {
			attachmentHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/window/") {
			historyWindowHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/live/") {
			liveTimelineHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/imported/") {
			importedTimelineHandler.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v3/history/revision/") || strings.HasPrefix(r.URL.Path, "/api/v3/history/checklist/") ||
			strings.HasPrefix(r.URL.Path, "/api/v3/history/poll/") {
			revisionHandler.ServeHTTP(w, r)
			return
		}
		runtimeHandler.ServeHTTP(w, r)
	}))
	defer runtimeServer.Close()
	fixture["base"] = runtimeServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: runtimeServer.Certificate().Raw}))
	legacyConfig := httptest.NewRecorder()
	legacyAPI := membershipAPI{store: writer, cfg: config{AuthBinding: "tls-sha256:" + publicKeyID(runtimeServer.Certificate().Raw)}}
	legacyAPI.publicConfig(legacyConfig, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if legacyConfig.Code != http.StatusOK {
		t.Fatalf("fixture could not sign legacy discovery: %d", legacyConfig.Code)
	}
	fixture["legacyConfig"] = json.RawMessage(legacyConfig.Body.Bytes())
	fixture["policyProof"] = proof
	enrollRecipient("read-protected")
	var after int
	if err := writer.db.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&after); err != nil || after != legacySessions {
		t.Fatalf("API 3 wrote frozen API 2 sessions: %d, %v", after, err)
	}
	challenge, err := runtime.issueSessionChallenge()
	if err != nil {
		t.Fatal(err)
	}
	sessionFrame, err := signatureFrame("pawtalk-protected-session-v1", runtime.serverID, runtime.cutoverDigest, runtime.store.protectedBinding, challenge.Nonce, enrolled.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: enrolled.DeviceID, Nonce: challenge.Nonce,
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(owner.device, sessionFrame))})
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := openProtectedRuntime(ctx, writer, dir, report.BackupArchiveSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.resolveSession(session.Token)(ctx, writer.db); err == nil || err.Error() != "INVALID_PROTECTED_SESSION" {
		t.Fatalf("previous runtime token survived listener restart: %v", err)
	}
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rtc" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer media.Close()
	mediaTarget, err := url.Parse(media.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := restarted.handlerWithVoice(config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64)}, mediaTarget)
	restartedServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mediaURLKey{}, "wss://"+r.Host+"/rtc")))
	}))
	defer restartedServer.Close()
	fixture["base"] = restartedServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: restartedServer.Certificate().Raw}))
	enrollRecipient("policy-runtime")
	inviteHandler := restarted.handler()
	inviteServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Test actors share loopback. Give the invitee its own IP quota.
		if r.Header.Get("X-PawTalk-Test-Peer") == "invitee" {
			r.RemoteAddr = "127.0.0.2:12345"
			r.Header.Del("X-PawTalk-Test-Peer")
		}
		inviteHandler.ServeHTTP(w, r)
	}))
	defer inviteServer.Close()
	fixture["base"] = inviteServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: inviteServer.Certificate().Raw}))
	enrollRecipient("invites-runtime")
	moderationServer := httptest.NewTLSServer(restarted.handler())
	defer moderationServer.Close()
	fixture["base"] = moderationServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: moderationServer.Certificate().Raw}))
	enrollRecipient("moderation-runtime")
	var inheritedCount int
	if err := writer.db.QueryRow("SELECT count(*) FROM ban_actions WHERE revoked_at IS NULL").Scan(&inheritedCount); err != nil || inheritedCount != 2 {
		t.Fatalf("protected lift changed frozen API 2 ban records: %d, %v", inheritedCount, err)
	}
	if retry, err := activateStandaloneProtectedRuntime(ctx, dir, report.BackupArchiveSHA256); err != nil || retry != activation {
		t.Fatalf("activation retry after live policy changes: %+v, %v", retry, err)
	}
	t.Run("native protected startup", func(t *testing.T) {
		checkStandaloneProtectedStartup(t, ctx, dir, activation)
	})
	recoveryDB, err := openMigrationImportDatabase(recoveryDBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer recoveryDB.Close()
	recoveryStore := &membershipStore{db: recoveryDB, now: writer.now}
	recoveryRuntime, err := openProtectedRuntime(ctx, recoveryStore, recoveryDir, report.BackupArchiveSHA256)
	if err != nil {
		t.Fatal(err)
	}
	exerciseMigratedQuotaAndAuditRetention(t, ctx, recoveryRuntime, proof.Principal, owner.device,
		recovery.ChannelID, keys[access.LiveEpoch])
	recoveryHandler := recoveryRuntime.handler()
	recoveryServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-PawTalk-Test-Peer") == "invitee" {
			r.RemoteAddr = "127.0.0.2:12345"
			r.Header.Del("X-PawTalk-Test-Peer")
		}
		recoveryHandler.ServeHTTP(w, r)
	}))
	defer recoveryServer.Close()
	fixture["base"] = recoveryServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: recoveryServer.Certificate().Raw}))
	const legacySessionState = `SELECT count(*),count(revoked_at) FROM sessions`
	var frozenBefore, frozenAfter [2]int
	if err := recoveryDB.QueryRow(legacySessionState).Scan(&frozenBefore[0], &frozenBefore[1]); err != nil {
		t.Fatal(err)
	}
	enrollRecipient("recover-migrated-owner")
	if err := recoveryDB.QueryRow(legacySessionState).Scan(&frozenAfter[0], &frozenAfter[1]); err != nil || frozenBefore != frozenAfter {
		t.Fatalf("owner recovery modified frozen API 2 sessions: %v -> %v: %v", frozenBefore, frozenAfter, err)
	}
	if retry, err := activateStandaloneProtectedRuntime(ctx, recoveryDir, report.BackupArchiveSHA256); err != nil || retry != activation {
		t.Fatalf("activation retry after owner recovery: %+v, %v", retry, err)
	}
	missingGenesis, err := recoveryDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer missingGenesis.Rollback()
	if _, err := missingGenesis.ExecContext(ctx, "DELETE FROM protected_scope_authority_genesis WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyProtectedActivation(ctx, missingGenesis, recoveryDir); err == nil {
		t.Fatal("protected startup accepted missing migrated genesis authority")
	}
	if err := missingGenesis.Rollback(); err != nil {
		t.Fatal(err)
	}
	laterRecoveryServer := httptest.NewTLSServer(restarted.handler())
	defer laterRecoveryServer.Close()
	fixture["base"] = laterRecoveryServer.URL
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: laterRecoveryServer.Certificate().Raw}))
	enrollRecipient("recover-migrated-owner-after-changes")
	corrupt, err := writer.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer corrupt.Rollback()
	if _, err := corrupt.ExecContext(ctx, "UPDATE protected_policy_proofs SET snapshot=x'7b7d' WHERE revision=2"); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyProtectedActivation(ctx, corrupt, dir); err == nil {
		t.Fatal("protected startup accepted a corrupted intermediate snapshot")
	}
}

func testProtectedMigrationRestoredBackup(t *testing.T, ctx context.Context, source *membershipStore, state []byte,
	node, script, archive string, fixture map[string]any) {
	t.Helper()
	openCopy := func() *protectedRuntime {
		t.Helper()
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "state.json"), state, 0600); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, membershipDatabaseFile)
		if _, err := source.db.ExecContext(ctx, "VACUUM INTO ?", path); err != nil {
			t.Fatal(err)
		}
		db, err := openMigrationImportDatabase(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		runtime, err := openProtectedRuntime(ctx, &membershipStore{db: db, now: source.now}, dir, archive)
		if err != nil {
			t.Fatal(err)
		}
		return runtime
	}
	current, restored := openCopy().handler(), openCopy().handler()
	var useRestored atomic.Bool
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Keep the endpoint and TLS identity stable while exposing the old copy.
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/fixture/restore-older-copy":
			useRestored.Store(true)
			respond(w, http.StatusOK, struct{}{})
		case r.Method == http.MethodPost && r.URL.Path == "/fixture/reconnect-current-copy":
			useRestored.Store(false)
			respond(w, http.StatusOK, struct{}{})
		case useRestored.Load():
			restored.ServeHTTP(w, r)
		default:
			current.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	fixture["base"], fixture["recipient"] = server.URL, "restored-backup-runtime"
	fixture["certificate"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))
	input, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if output, err := runMigrationClient(ctx, node, script, input); err != nil {
		t.Fatalf("restored backup Client integration: %v\n%s", err, output)
	}
}

func runMigrationClient(ctx context.Context, node, script string, input []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, node, script)
	hideWindow(command)
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		return output, ctx.Err()
	}
	return output, err
}

func testImportedHistorySnapshot(t *testing.T, ctx context.Context, store *membershipStore, ownerID, channel string,
	first, second migratedHistoryPacket) {
	t.Helper()
	path := filepath.Join(t.TempDir(), membershipDatabaseFile)
	if _, err := store.db.ExecContext(ctx, "VACUUM INTO ?", path); err != nil {
		t.Fatal(err)
	}
	db, err := openMigrationImportDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store = &membershipStore{db: db, now: store.now}
	draft := loadTestMigrationPolicyDraft(t, store)
	if draft.State == nil {
		t.Fatal("missing initial access policy")
	}
	const memberID = "new-profile"
	draft.State.Members[memberID] = access.Subject{ID: memberID, Active: true}
	policyStore := access.NewStoreWithClock(store.db, store.now)
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := policyStore.InitializeInTransaction(ctx, tx, *draft.State); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var initialized bool
	if err := store.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_policy')").
		Scan(&initialized); err != nil || initialized {
		t.Fatalf("failed transaction left a policy: %t, %v", initialized, err)
	}
	if err := policyStore.Initialize(ctx, *draft.State); err != nil {
		t.Fatal(err)
	}
	read := func(profile, id string, after uint64) (importedProtectedPage, error) {
		var result importedProtectedPage
		resolve := func(context.Context, access.SessionQuery) (access.Principal, error) {
			return access.Principal{ProfileID: profile}, nil
		}
		err := store.dispatchImportedProtectedHistory(ctx, resolve, id, after, 1, func(page importedProtectedPage) error {
			result = page
			return nil
		})
		return result, err
	}
	page, err := read(ownerID, channel, 0)
	if err != nil || len(page.Messages) != 1 || page.Next != 1 || page.Messages[0].Position != 1 ||
		page.Messages[0].Packet.ID != first.ID || page.Messages[0].Packet.Signature != first.Signature ||
		!bytes.Equal(page.Messages[0].Packet.Ciphertext, first.Ciphertext) {
		t.Fatalf("owner import page lost original provenance: %+v, %v", page, err)
	}
	page, err = read(ownerID, channel, page.Next)
	if err != nil || len(page.Messages) != 1 || page.Next != 0 || page.Messages[0].Position != 2 || page.Messages[0].Packet.ID != second.ID {
		t.Fatalf("owner continuation used the wrong position: %+v, %v", page, err)
	}
	if page, err = read(memberID, channel, 0); err != nil || len(page.Messages) != 0 || page.Next != 0 {
		t.Fatalf("new member saw imported ciphertext without full history: %+v, %v", page, err)
	}
	if page, err = read("removed-profile", channel, 0); err != access.MissingGrant || len(page.Messages) != 0 {
		t.Fatalf("inactive profile received an archive page: %+v, %v", page, err)
	}
}

func testMigrationHistoryHTTPSource(t *testing.T, dir, preparation string) (*membershipStore, *atomic.Int64, testMemberSigner, testMemberSigner, testMemberSigner, protectedMigrationReport) {
	t.Helper()
	var clock atomic.Int64
	clock.Store(time.Unix(10000, 0).UnixMilli())
	now := func() time.Time { return time.UnixMilli(clock.Load()) }
	state, err := createState("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveState(dir, state); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, membershipDatabaseFile)
	store, err := openMembershipDatabase(path, now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.db.Close() })
	owner, admin, revoked := newTestMemberSigner(1), newTestMemberSigner(2), newTestMemberSigner(3)
	first := bootstrapTestServer(t, store, owner)
	activateTestMember(t, store, admin, "admin")
	removed := activateTestMember(t, store, revoked, "member")
	if _, err := store.db.Exec("UPDATE memberships SET state='revoked' WHERE profile_id=?", removed.ProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", removed.ProfileID, first.Access.ProfileID, now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	banned := activateTestMember(t, store, newTestMemberSigner(5), "member")
	alias := activateTestMember(t, store, newTestMemberSigner(6), "member")
	if _, err := store.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)",
		alias.ProfileID, banned.ProfileID, now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	expiry := now().Add(30 * 24 * time.Hour).UnixMilli()
	if err := store.ban(context.Background(), first.Token, banned.ProfileID, strings.Repeat("b", 32), &expiry, "Timed legacy ban"); err != nil {
		t.Fatal(err)
	}
	if err := store.ban(context.Background(), first.Token, banned.ProfileID, strings.Repeat("c", 32), nil, strings.Repeat("Legacy ban ", 25)+"source"); err != nil {
		t.Fatal(err)
	}
	insertMigrationCiphertextFixture(t, store, first.Access, true)
	if _, err := store.db.Exec(`UPDATE channels SET position=(
		SELECT COUNT(*) FROM channels AS later WHERE later.channel_id>channels.channel_id)`); err != nil {
		t.Fatal(err)
	}
	var report protectedMigrationReport
	switch preparation {
	case "automatic":
		if err := prepareStandaloneMigration(t.Context(), dir); err != nil {
			t.Fatal(err)
		}
		report, err = inspectProtectedMigration(t.Context(), path, now())
	case "unprepared":
		report, err = inspectProtectedMigration(t.Context(), path, now())
	default:
		backup := copyMigrationDatabase(t, path)
		report, err = backup.prepare(context.Background(), path, now())
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	reader, err := openMembershipReadOnly(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reader.Close() })
	clock.Store(first.ExpiresAt + 1)
	return &membershipStore{db: reader, now: now}, &clock, owner, admin, revoked, report
}

func TestProtectedMigrationStandaloneOwnerControl(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	dir := t.TempDir()
	store, clock, owner, admin, _, report := testMigrationHistoryHTTPSource(t, dir, "automatic")
	backup, err := migrationFileSHA256(filepath.Join(dir, standaloneMigrationBackup))
	if err != nil || backup != report.BackupArchiveSHA256 {
		t.Fatalf("automatic backup does not match checkpoint: %v", err)
	}
	writer, err := openMigrationImportDatabase(filepath.Join(dir, membershipDatabaseFile))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	handler := newProtectedMigrationHandlerWithControl(store, &membershipStore{db: writer, now: store.now}, dir)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clock.Add(time.Second.Milliseconds())
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	if _, err := activateStandaloneProtectedRuntime(t.Context(), dir, backup); err == nil {
		t.Fatal("activation succeeded before owner approval")
	}
	seeds := func(signer testMemberSigner) map[string]string {
		return map[string]string{"root": hex.EncodeToString(signer.root.Seed()), "device": hex.EncodeToString(signer.device.Seed())}
	}
	input, err := json.Marshal(map[string]any{
		"base": server.URL, "serverId": report.ServerID, "archiveSha256": backup,
		"legacySecret": migrationFixtureLegacySecret, "owner": seeds(owner), "admin": seeds(admin),
		"certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})),
		"recipient":   "automatic-standalone",
	})
	if err != nil {
		t.Fatal(err)
	}
	if output, err := runMigrationClient(t.Context(), node, "../client/windows/scripts/protected-migration-history-integration.cjs", input); err != nil {
		t.Fatalf("standalone owner migration failed: %v\n%s", err, output)
	}
	activation, err := activateStandaloneProtectedRuntime(t.Context(), dir, backup)
	if err != nil || activation.ArchiveSHA256 != backup || !validHexID(activation.CutoverDigest, 64) {
		t.Fatalf("invalid committed activation: %v", err)
	}
	if after, err := migrationFileSHA256(filepath.Join(dir, standaloneMigrationBackup)); err != nil || after != backup {
		t.Fatalf("source backup changed across activation: %v", err)
	}
}

func insertMigrationCiphertextFixture(t *testing.T, store *membershipStore, author memberAccess, withChecklist bool) {
	t.Helper()
	var serverID, channelID string
	if err := store.db.QueryRow(`SELECT s.server_id,c.channel_id FROM server_state s CROSS JOIN channels c
		WHERE s.id=1 AND c.protected_kind='default_text'`).Scan(&serverID, &channelID); err != nil {
		t.Fatal(err)
	}
	secret, _ := hex.DecodeString(migrationFixtureLegacySecret)
	salt, _ := hex.DecodeString(serverID)
	keyID := publicKeyID(secret)
	if _, err := store.db.Exec("UPDATE server_state SET e2ee_key_id=? WHERE id=1", keyID); err != nil {
		t.Fatal(err)
	}
	encrypt := func(purpose, channel, resource string, content []byte) ([]byte, []byte) {
		t.Helper()
		info, err := signatureFrame("pawtalk-key-v2", purpose, channel, keyID)
		if err != nil {
			t.Fatal(err)
		}
		key, err := hkdf.Key(sha256.New, secret, salt, string(info), 32)
		if err != nil {
			t.Fatal(err)
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		aesGCM, err := cipher.NewGCM(block)
		if err != nil {
			t.Fatal(err)
		}
		aad, err := signatureFrame("pawtalk-content-v2", serverID, purpose, channel, resource, author.ProfileID, keyID)
		if err != nil {
			t.Fatal(err)
		}
		nonce := make([]byte, aesGCM.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			t.Fatal(err)
		}
		return nonce, aesGCM.Seal(nil, nonce, content, aad)
	}
	const originalID int64 = 9007199254740991
	const attachmentSize = 1024*1024 + 11
	attachment := strings.Repeat("d", 32)
	item := strings.Repeat("a", 32)
	for _, id := range []int64{originalID, 9007199254740994} {
		requestID := strconv.FormatInt(id, 10)
		message := map[string]any{"text": "legacy history /" + requestID}
		if id == originalID && withChecklist {
			message["file"] = map[string]any{"id": attachment, "name": "archive.bin", "mime": "application/octet-stream", "size": attachmentSize}
		}
		if id != originalID {
			message["reply"] = map[string]any{"id": originalID, "author": "Copied old author", "text": "Copied old excerpt"}
			if withChecklist {
				message["checklist"] = map[string]any{"everyone": true, "items": []map[string]string{{"id": item, "text": "Encrypted item"}}}
			}
		}
		content, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		nonce, ciphertext := encrypt("chat", channelID, requestID, content)
		if _, err := store.db.Exec(`INSERT INTO messages(message_id,channel_id,author_profile_id,author_device_id,request_id,sent_at,crypto_context_id,nonce,ciphertext)
			VALUES(?,?,?,?,?,?,?,?,?)`, id, channelID, author.ProfileID, author.DeviceID, requestID, store.now().UnixMilli(), keyID, nonce, ciphertext); err != nil {
			t.Fatal(err)
		}
	}
	if withChecklist {
		nonce, ciphertext := encrypt("attachment", channelID, attachment, bytes.Repeat([]byte{0x62}, attachmentSize))
		if _, err := store.db.Exec(`INSERT INTO attachments(attachment_id,channel_id,message_id,owner_device_id,crypto_context_id,nonce,ciphertext,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, attachment, channelID, originalID, author.DeviceID, keyID, nonce, ciphertext, store.now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec("INSERT INTO checklists(message_id,item_ids,checked,everyone) VALUES(?,?,?,1)",
			int64(9007199254740994), `["`+item+`"]`, `{"`+item+`":true}`); err != nil {
			t.Fatal(err)
		}
		const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII="
		avatarNonce, avatarCipher := encrypt("avatar", "", "server-avatar", []byte(avatar))
		envelope, err := json.Marshal(memberInvitePackage{Version: 2, KeyID: keyID,
			Nonce: b64.EncodeToString(avatarNonce), Ciphertext: b64.EncodeToString(avatarCipher)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec("UPDATE server_avatar SET envelope=?,author_profile_id=?,revision=2 WHERE id=1", envelope, author.ProfileID); err != nil {
			t.Fatal(err)
		}
		profileNonce, profileCipher := encrypt("avatar", "", author.ProfileID, []byte(avatar))
		profileEnvelope, err := json.Marshal(memberInvitePackage{Version: 2, KeyID: keyID,
			Nonce: b64.EncodeToString(profileNonce), Ciphertext: b64.EncodeToString(profileCipher)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec("UPDATE profiles SET avatar_envelope=? WHERE profile_id=?", profileEnvelope, author.ProfileID); err != nil {
			t.Fatal(err)
		}
	}
}
