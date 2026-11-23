package access

const graceMillis = 60_000

// EpochWindow is the write-side part of a channel's durable key state.
// Callers still check membership, channel admission, signed policy and keys.
type EpochWindow struct {
	Current        uint64
	CurrentCutoff  int64
	PreviousCutoff int64
	// A new admission may require a key that does not reveal earlier data.
	NeedsFresh bool
}

// Revoke records the first effective revoke for the current key.
// Subsequent revokes before rotation cannot extend the same key's lifetime.
func (w EpochWindow) Revoke(appliedAt int64) EpochWindow {
	cutoff := appliedAt + graceMillis
	if w.CurrentCutoff == 0 || cutoff < w.CurrentCutoff {
		w.CurrentCutoff = cutoff
	}
	return w
}

// Rotate activates the next epoch. The policy version CAS and package
// verification must succeed in the same transaction before storing this state.
func (w EpochWindow) Rotate() EpochWindow {
	next := EpochWindow{Current: w.Current + 1}
	if !w.NeedsFresh {
		next.PreviousCutoff = w.CurrentCutoff
	}
	return next
}

func (w EpochWindow) Accepts(epoch uint64, now int64) bool {
	if epoch == 0 || w.NeedsFresh {
		return false
	}
	if epoch == w.Current {
		return w.CurrentCutoff == 0 || now < w.CurrentCutoff
	}
	return w.Current > 1 && epoch == w.Current-1 && w.PreviousCutoff != 0 && now < w.PreviousCutoff
}
