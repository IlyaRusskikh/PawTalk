package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

const importedAttachmentChunkSize = access.AttachmentBlockSize
const importedAttachmentMaxCiphertext = access.MaxAttachmentCiphertext

type importedAttachmentChunk struct {
	Packet migratedHistoryPacket `json:"packet"`
	Offset int                   `json:"offset"`
	Total  int                   `json:"total"`
	Bytes  []byte                `json:"bytes"`
}

func readImportedAttachmentChunk(ctx context.Context, conn *sql.Conn, channel, id string, position, first, next uint64, offset int) (importedAttachmentChunk, error) {
	if position < first || position >= next {
		return importedAttachmentChunk{}, access.ChannelRestricted
	}
	chunk := importedAttachmentChunk{Offset: offset, Packet: migratedHistoryPacket{Version: 1, Kind: "attachments", Generation: 1, ID: id}}
	var signature, metadata []byte
	err := conn.QueryRowContext(ctx, `SELECT r.key_id,r.metadata,r.source_digest,r.nonce,r.migrator_device_id,r.signature,
		source.backup_archive_sha256,length(r.ciphertext),substr(r.ciphertext,?,?)
		FROM protected_migration_message_positions i
		JOIN messages m ON m.channel_id=i.channel_id AND m.message_id=i.message_id
		JOIN attachments a ON a.channel_id=i.channel_id AND a.message_id=i.message_id
		JOIN protected_migration_records r ON r.kind='attachments' AND r.channel_id=i.channel_id AND r.source_id=a.attachment_id
		JOIN protected_migration_records original ON original.kind='messages' AND original.channel_id=i.channel_id
			AND original.source_id=CAST(i.message_id AS TEXT)
		CROSS JOIN protected_migration_source source
		WHERE source.id=1 AND i.channel_id=? AND i.position=? AND a.attachment_id=?
		AND length(r.ciphertext) BETWEEN 17 AND ?
		AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)
		AND `+access.ImportedPollResultAllowed("?", true), offset+1, importedAttachmentChunkSize,
		channel, position, id, importedAttachmentMaxCiphertext, first).
		Scan(&chunk.Packet.KeyID, &metadata, &chunk.Packet.SourceDigest, &chunk.Packet.Nonce, &chunk.Packet.MigratorDeviceID, &signature,
			&chunk.Packet.ArchiveSHA256, &chunk.Total, &chunk.Bytes)
	if errors.Is(err, sql.ErrNoRows) {
		return importedAttachmentChunk{}, access.ChannelRestricted
	}
	if err != nil {
		return importedAttachmentChunk{}, err
	}
	if offset >= chunk.Total {
		return importedAttachmentChunk{}, access.InvalidAction
	}
	chunk.Packet.Signature = b64.EncodeToString(signature)
	chunk.Packet.Metadata = metadata
	return chunk, nil
}

func (p *protectedRuntime) importedAttachmentHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	id := r.PathValue("attachment")
	rawOffset := r.URL.Query().Get("offset")
	offset, offsetErr := strconv.Atoi(rawOffset)
	if err != nil || !validHexID(id, 32) || offsetErr != nil || strconv.Itoa(offset) != rawOffset ||
		offset < 0 || offset >= importedAttachmentMaxCiphertext || offset%importedAttachmentChunkSize != 0 {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchHistory(r.Context(), p.resolveSession(memberBearer(r)), channel,
		func(conn *sql.Conn, first, next uint64) error {
			if p.importedProfileNames == nil {
				return access.ChannelRestricted
			}
			chunk, err := readImportedAttachmentChunk(r.Context(), conn, channel, id, position, first, next, offset)
			if err != nil {
				return err
			}
			return writeProtectedDelivery(w, &sent, chunk)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) putLiveAttachmentHTTP(w http.ResponseWriter, r *http.Request) {
	channel, id := r.PathValue("channel"), r.PathValue("attachment")
	if !validHexID(channel, 32) || !validHexID(id, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var input struct {
		Kind string `json:"kind"`
		access.AttachmentBlock
	}
	const maxBody = (access.AttachmentBlockSize+2)/3*4 + 256
	if _, err := decodeMemberJSON(w, r, maxBody, &input); err != nil {
		memberFail(w, err)
		return
	}
	ref := access.MessageAttachment{ID: id, Kind: input.Kind}
	err := access.NewStoreWithClock(p.store.db, p.store.now).PutAttachmentBlock(r.Context(), p.resolveSession(memberBearer(r)),
		channel, ref, input.AttachmentBlock, p.store.checkProtectedAttachmentStorage)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) liveAttachmentHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	id := r.PathValue("attachment")
	rawOffset := r.URL.Query().Get("offset")
	offset, offsetErr := strconv.Atoi(rawOffset)
	if err != nil || offsetErr != nil || strconv.Itoa(offset) != rawOffset {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err = access.NewStoreWithClock(p.store.db, p.store.now).DispatchAttachmentBlock(r.Context(), p.resolveSession(memberBearer(r)),
		channel, position, id, offset, func(block access.AttachmentBlock) error { return writeProtectedDelivery(w, &sent, block) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (s *membershipStore) checkProtectedAttachmentStorage(ctx context.Context, tx *sql.Tx) error {
	if s.maxBytes == 0 {
		return nil
	}
	used, err := memberStorageUsed(ctx, tx)
	if err != nil {
		return err
	}
	if used > s.maxBytes {
		return memberError(http.StatusInsufficientStorage, "STORAGE_LIMIT")
	}
	return nil
}
