package access

import (
	"context"
	"fmt"
)

func checkDeferredAdmission(ctx context.Context, query SessionQuery, anchored bool, revision int64,
	profileID, channelID string, checkpoint DeferredAdmission) error {
	if !anchored || !isDigest(checkpoint.Head) || checkpoint.Revision < 1 || checkpoint.Revision > revision {
		return ErrDeferredAdmissionChanged
	}
	// FirstPosition can repeat after readmission. Instead of comparing its
	// value, require the profile's admission in every committed policy snapshot.
	path := fmt.Sprintf("$.Admissions.%q.%q.FirstPosition", channelID, profileID)
	var continuous int64
	err := query.QueryRowContext(ctx, `SELECT COUNT(*) FROM protected_policy_proofs
		WHERE revision BETWEEN ? AND ? AND (revision > ? OR digest = ?)
		  AND json_extract(CAST(snapshot AS TEXT), ?) > 0`,
		checkpoint.Revision, revision, checkpoint.Revision, checkpoint.Head, path).Scan(&continuous)
	if err != nil {
		return err
	}
	if continuous != revision-checkpoint.Revision+1 {
		return ErrDeferredAdmissionChanged
	}
	return nil
}
