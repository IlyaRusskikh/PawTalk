package main

import (
	"net/http"
	"net/url"

	"pawtalk/server/internal/access"
)

func recoveryRotationMode(r *http.Request) (bool, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return false, access.InvalidAction
	}
	values, selected := query["recovery"]
	if selected && (len(values) != 1 || values[0] != "1") {
		return false, access.InvalidAction
	}
	return selected, nil
}

func (p *protectedRuntime) pendingRotationsHTTP(w http.ResponseWriter, r *http.Request) {
	recovery, err := recoveryRotationMode(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	dispatch := store.DispatchPendingRotations
	if recovery {
		dispatch = store.DispatchPendingRecoveryRotations
	}
	var sent bool
	err = dispatch(r.Context(),
		p.resolveSession(memberBearer(r)), func(tasks []access.PendingRotation) error {
			return writeProtectedDelivery(w, &sent, tasks)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) claimRotationHTTP(w http.ResponseWriter, r *http.Request) {
	channel, purpose := r.PathValue("channel"), r.PathValue("purpose")
	if !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	recovery, err := recoveryRotationMode(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	scoped := p.scopedTextCache(r)
	proof, err := readProtectedProofRequest(r, scoped != nil, true)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	dispatch := store.DispatchRotationTask
	if recovery {
		dispatch = store.DispatchRecoveryRotationTask
	}
	var sent bool
	resolve := p.resolveSession(memberBearer(r))
	deliver := func(task access.RotationTask) error {
		proof.beforePartial = func() error {
			if task.LeaseUntil <= p.store.now().UnixMilli() {
				return protectedProofChanged()
			}
			return nil
		}
		return proof.write(w, &sent, task, task.LeaseID)
	}
	if proof.offset > 0 {
		err = store.DispatchRotationTaskContinuation(r.Context(), resolve, channel, purpose, scoped, recovery, proof.lease, deliver)
	} else if r.URL.Query().Get("transition") == "1" {
		err = store.DispatchTransitionRotationTask(r.Context(), resolve, channel, purpose, scoped, recovery, deliver)
	} else {
		err = dispatch(r.Context(), resolve, channel, purpose, scoped, deliver)
	}
	if err != nil && !sent {
		protectedRuntimeFail(w, proof.failure(err))
	}
}

func (p *protectedRuntime) rotationTargetsHTTP(w http.ResponseWriter, r *http.Request) {
	p.deliverRotationTargetsHTTP(w, r, false)
}

func (p *protectedRuntime) rotationRecoveryTargetsHTTP(w http.ResponseWriter, r *http.Request) {
	p.deliverRotationTargetsHTTP(w, r, true)
}

func (p *protectedRuntime) deliverRotationTargetsHTTP(w http.ResponseWriter, r *http.Request, recovery bool) {
	var input struct {
		Record  access.EpochRecord
		Targets []access.ArchiveTarget
	}
	if _, err := decodeMemberJSON(w, r, 16<<10, &input); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(input.Record.ChannelID, 32) || input.Record.ChannelID != r.PathValue("channel") {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	scoped := p.scopedTextCache(r)
	proof, err := readProtectedProofRequest(r, scoped != nil, false)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	dispatch := store.DispatchRotationTargetPackages
	if recovery {
		dispatch = store.DispatchRotationRecoveryTargetPackages
	}
	var sent bool
	err = dispatch(r.Context(),
		p.resolveSession(memberBearer(r)), input.Record, input.Targets, verifyProtectedEpochSignature, scoped,
		func(deliveries []access.EpochPackageDelivery) error {
			return proof.write(w, &sent, deliveries, "")
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, proof.failure(err))
	}
}

func (p *protectedRuntime) commitRotationHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Record   access.EpochRecord
		Packages []access.EpochPackage
		Links    []access.ArchiveLink
	}
	if _, err := decodeMemberJSON(w, r, 4<<20, &input); err != nil {
		memberFail(w, err)
		return
	}
	record := input.Record
	if !validHexID(record.ChannelID, 32) || record.ChannelID != r.PathValue("channel") ||
		record.Purpose != r.PathValue("purpose") || record.Generation > uint64(migrationMaxSafePosition) ||
		len(input.Packages) == 0 || len(input.Packages) > 8192 || len(input.Links) > 129 {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	if err := store.CommitEpoch(r.Context(), p.resolveSession(memberBearer(r)), verifyProtectedEpochSignature, record, input.Packages, input.Links); err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"generation": record.Generation, "keyId": record.KeyID, "signatureDigest": publicKeyID(record.Signature)})
}
