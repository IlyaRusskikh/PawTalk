package access

import (
	"context"
	"database/sql"
	"slices"
)

// DispatchOwnDevices sends the active signing device IDs of the caller's
// effective profile under the same lock used by device and profile changes.
func (s *Store) DispatchOwnDevices(ctx context.Context, resolve ResolveSession, deliver func([]string) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(_ *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
			return Inactive
		}
		var ids []string
		for id, device := range state.PolicyDevices {
			if device.ProfileID == actor.ProfileID && !device.Revoked {
				ids = append(ids, id)
			}
		}
		slices.Sort(ids)
		return deliver(ids)
	})
}
