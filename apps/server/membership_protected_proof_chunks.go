package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

const (
	protectedProofChunkBytes = 16 << 20
	protectedProofOffset     = "PawTalk-Proof-Offset"
	protectedProofLease      = "PawTalk-Proof-Lease"
)

type protectedProofRequest struct {
	enabled       bool
	offset        int
	match         string
	lease         string
	beforePartial func() error
}

func readProtectedProofRequest(r *http.Request, scoped, claim bool) (protectedProofRequest, error) {
	offsets := r.Header.Values(protectedProofOffset)
	matches := r.Header.Values("If-Match")
	leases := r.Header.Values(protectedProofLease)
	if len(offsets) == 0 && len(matches) == 0 && len(leases) == 0 {
		return protectedProofRequest{}, nil
	}
	invalid := memberError(http.StatusBadRequest, "INVALID_PROTECTED_PROOF_RANGE")
	if !scoped || len(offsets) != 1 {
		return protectedProofRequest{}, invalid
	}
	offset, err := strconv.ParseUint(offsets[0], 10, 63)
	if err != nil || strconv.FormatUint(offset, 10) != offsets[0] || offset%protectedProofChunkBytes != 0 ||
		uint64(int(offset)) != offset {
		return protectedProofRequest{}, invalid
	}
	if offset == 0 {
		if len(matches) != 0 || len(leases) != 0 {
			return protectedProofRequest{}, invalid
		}
		return protectedProofRequest{enabled: true}, nil
	}
	if len(matches) != 1 || len(matches[0]) != 66 || matches[0][0] != '"' || matches[0][65] != '"' ||
		!validHexID(matches[0][1:65], 64) {
		return protectedProofRequest{}, invalid
	}
	if claim && (len(leases) != 1 || !validHexID(leases[0], 32)) || !claim && len(leases) != 0 {
		return protectedProofRequest{}, invalid
	}
	return protectedProofRequest{enabled: true, offset: int(offset), match: matches[0], lease: r.Header.Get(protectedProofLease)}, nil
}

func protectedProofChanged() error {
	return memberError(http.StatusPreconditionFailed, "PROTECTED_PROOF_CHANGED")
}

func (request protectedProofRequest) failure(err error) error {
	if request.offset > 0 && (errors.Is(err, access.ErrPolicyConflict) || errors.Is(err, access.ErrEpochConflict) ||
		errors.Is(err, access.ErrEpochStale) || errors.Is(err, access.ErrEpochRecipients) ||
		errors.Is(err, access.ErrPolicyAttestationUnavailable) || errors.Is(err, access.ErrRotationLease) ||
		errors.Is(err, access.ErrRotationUnavailable)) {
		return protectedProofChanged()
	}
	return err
}

func (request protectedProofRequest) write(w http.ResponseWriter, sent *bool, value any, lease string) error {
	if !request.enabled {
		return writeProtectedDelivery(w, sent, value)
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if request.offset == 0 && len(body) <= protectedProofChunkBytes {
		return writeProtectedDeliveryBody(w, sent, body, http.StatusOK, "application/json", nil)
	}
	digest := sha256.Sum256(body)
	tag := `"` + hex.EncodeToString(digest[:]) + `"`
	if request.offset > 0 && (request.match != tag || request.lease != lease) {
		return protectedProofChanged()
	}
	if request.offset >= len(body) {
		return memberError(http.StatusRequestedRangeNotSatisfiable, "INVALID_PROTECTED_PROOF_RANGE")
	}
	if request.beforePartial != nil {
		if err := request.beforePartial(); err != nil {
			return err
		}
	}
	end := request.offset + min(protectedProofChunkBytes, len(body)-request.offset)
	return writeProtectedDeliveryBody(w, sent, body[request.offset:end], http.StatusPartialContent, "application/octet-stream", func(header http.Header) {
		header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", request.offset, end-1, len(body)))
		header.Set("ETag", tag)
		header.Set("Cache-Control", "private, no-store")
		if lease != "" {
			header.Set(protectedProofLease, lease)
		}
	})
}
