package main

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"

	"pawtalk/server/internal/access"
)

const protectedMemberRequestsPerMinute = 1200

type protectedRequestLimiter struct {
	public  *membershipAPI
	members *membershipAPI
}

func newProtectedRequestLimiter(store *membershipStore) *protectedRequestLimiter {
	return &protectedRequestLimiter{
		public:  &membershipAPI{store: store, attempts: make(map[string]attempt)},
		members: &membershipAPI{store: store, attempts: make(map[string]attempt)},
	}
}

func (l *protectedRequestLimiter) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		profileID, administrator := l.members.store.protectedRateIdentity(r)
		if profileID == "" {
			if l.public.rate(w, r) {
				next(w, r)
			}
			return
		}
		if administrator || l.members.allowRate(w, profileID, protectedMemberRequestsPerMinute) {
			next(w, r)
		}
	}
}

func (s *membershipStore) protectedRateIdentity(r *http.Request) (profileID string, administrator bool) {
	bearer := memberBearer(r)
	if len(bearer) != b64.EncodedLen(sha256.Size) {
		return "", false
	}
	token, err := decodeFixed(bearer, sha256.Size)
	if err != nil {
		return "", false
	}
	hash := sha256.Sum256(token)
	clear(token)

	// Use the runtime session and its current effective profile in one snapshot.
	// The exemption only selects the request budget. Every route still verifies
	// its session, policy proof and permission as part of the operation.
	var deviceID string
	var snapshot []byte
	err = s.db.QueryRowContext(r.Context(), `SELECT s.device_id,p.snapshot
		FROM protected_runtime_sessions s JOIN protected_policy p ON p.id=1
		WHERE s.token_hash=? AND s.binding=? AND s.expires_at>?`,
		hash[:], s.protectedBinding, s.now().UnixMilli()).Scan(&deviceID, &snapshot)
	if err != nil {
		return "", false
	}
	var policy struct {
		access.RoleSnapshot
		PolicyDevices  map[string]access.PolicyDevice
		PolicyAnchored bool
	}
	if json.Unmarshal(snapshot, &policy) != nil || !policy.PolicyAnchored {
		return "", false
	}
	device := policy.PolicyDevices[deviceID]
	member := policy.Members[device.ProfileID]
	if device.Revoked || !member.Active || member.ID == "" || member.ID != device.ProfileID {
		return "", false
	}
	return member.ID, policy.CheckGrant(member, access.Scope{}, access.Administrator, s.now().UnixMilli()) == access.Allowed
}
