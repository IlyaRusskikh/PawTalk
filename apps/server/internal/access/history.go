package access

// Admission starts at the first channel position eligible for delivery in the
// current continuous interval. Zero means the profile has no current access.
type Admission struct{ FirstPosition uint64 }

// Update must run in the same transaction as the effective access change.
// nextPosition is the first position that can be assigned after the change.
func (a Admission) Update(canView bool, nextPosition uint64) Admission {
	if !canView {
		return Admission{}
	}
	if a.FirstPosition == 0 {
		return Admission{FirstPosition: nextPosition}
	}
	return a
}

// CanRead uses the object's original send position for every edit, reference
// and derived object. A full-history change does not start a new interval.
func (a Admission) CanRead(originalPosition uint64, fullHistory bool) bool {
	return a.FirstPosition != 0 && originalPosition != 0 &&
		(fullHistory || originalPosition >= a.FirstPosition)
}
