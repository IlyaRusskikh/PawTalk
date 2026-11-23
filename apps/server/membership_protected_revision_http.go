package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

func resolveImportedRevisionSource(ctx context.Context, query access.SessionQuery, channel string, position uint64) (access.RevisionSource, error) {
	var source access.RevisionSource
	err := query.QueryRowContext(ctx, `SELECT COALESCE(b.target_profile_id,m.author_profile_id),r.signature
		FROM protected_migration_message_positions i
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		WHERE i.channel_id=? AND i.position=?
		AND NOT EXISTS (SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)
		AND NOT `+importedCannotEdit, channel, position).Scan(&source.Author, &source.Signature)
	if err != nil {
		return source, err
	}
	list, err := resolveImportedChecklist(ctx, query, channel, position)
	if errors.Is(err, sql.ErrNoRows) {
		return source, nil
	}
	if err != nil {
		return source, err
	}
	source.Checklist = &list
	return source, nil
}

func protectedRevisionFrame(serverID string, principal access.Principal, channel string, basis access.RevisionBasis,
	attempt access.RevisionAttempt) ([]byte, error) {
	packet, epoch := attempt.Packet, basis.Archive.Record
	fields := []string{"pawtalk-text-revision-signature-v1", serverID, channel, strconv.FormatUint(basis.Position, 10),
		basis.Original, strconv.FormatUint(basis.Revision, 10), basis.PreviousDigest, attempt.OperationID, principal.ProfileID, principal.DeviceID,
		strconv.FormatInt(basis.PolicyRevision, 10), basis.PolicyDigest, strconv.FormatUint(epoch.Generation, 10), epoch.KeyID, basis.ArchiveDigest,
		epoch.ArchiveWrapKey}
	if packet.Checklist != nil {
		fields = append(fields, packet.Checklist.Digest())
	}
	return signatureFrame(append(fields, b64.EncodeToString(packet.Nonce), publicKeyID(packet.Ciphertext),
		publicKeyID(packet.ArchivePackage), packet.RecipientDigest)...)
}

func verifyProtectedRevision(ctx context.Context, query access.SessionQuery, principal access.Principal, channel string,
	basis access.RevisionBasis, attempt access.RevisionAttempt) error {
	serverID, key, err := protectedSigner(ctx, query, principal.DeviceID)
	if err != nil {
		return err
	}
	frame, err := protectedRevisionFrame(serverID, principal, channel, basis, attempt)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, attempt.Packet.Signature) {
		return memberError(http.StatusForbidden, "INVALID_PROTECTED_REVISION")
	}
	return nil
}

func protectedRevisionScope(r *http.Request) (string, uint64, error) {
	channel := r.PathValue("channel")
	position, err := strconv.ParseUint(r.PathValue("position"), 10, 64)
	if err != nil || position == 0 || position >= uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		return "", 0, access.InvalidAction
	}
	return channel, position, nil
}

func (p *protectedRuntime) revisionSource() access.ResolveRevisionSource {
	if p.importedProfileNames == nil {
		return nil
	}
	return resolveImportedRevisionSource
}

func (p *protectedRuntime) revisionBasisHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchRevisionBasis(r.Context(), p.resolveSession(memberBearer(r)),
		verifyProtectedEpochSignature, p.revisionSource(), channel, position, p.scopedTextCache(r),
		func(basis access.RevisionBasis) error { return writeProtectedDelivery(w, &sent, basis) })
	if err != nil && !sent {
		protectedRevisionFail(w, err)
	}
}

func (p *protectedRuntime) commitRevisionHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	var attempt access.RevisionAttempt
	if _, err := decodeMemberJSON(w, r, 3<<20, &attempt); err != nil {
		memberFail(w, err)
		return
	}
	receipt, err := p.protectedContentStore().CommitRevision(r.Context(), p.resolveSession(memberBearer(r)),
		verifyProtectedEpochSignature, verifyProtectedRevision, p.revisionSource(), channel, position, attempt)
	if err != nil {
		protectedRevisionFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

func (p *protectedRuntime) readRevisionHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchRevision(r.Context(), p.resolveSession(memberBearer(r)),
		verifyProtectedEpochSignature, verifyProtectedRevision, p.revisionSource(), channel, position, p.scopedTextCache(r),
		func(value access.RevisionDelivery) error { return writeProtectedDelivery(w, &sent, value) })
	if err != nil && !sent {
		protectedRevisionFail(w, err)
	}
}

func protectedRevisionFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, access.ErrPolicyAttestationUnavailable):
		policyAttestationFail(w, err)
		return
	case errors.Is(err, access.ErrRevisionConflict), errors.Is(err, access.ErrEpochRecipients):
		err = memberError(http.StatusConflict, "PROTECTED_REVISION_CHANGED")
	case errors.Is(err, access.ErrRevisionUnavailable):
		err = memberError(http.StatusNotFound, "PROTECTED_REVISION_UNAVAILABLE")
	}
	protectedPolicyFail(w, err)
}
