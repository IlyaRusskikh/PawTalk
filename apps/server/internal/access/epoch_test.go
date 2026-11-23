package access

import (
	"encoding/json"
	"testing"
)

func TestGraceBoundToOriginalRevoke(t *testing.T) {
	initial := EpochWindow{Current: 2}
	window := initial.Revoke(1000)
	if !window.Accepts(2, 60_999) || window.Accepts(2, 61_000) {
		t.Fatal("pending epoch cutoff must be 60 seconds from revoke")
	}
	window = window.Revoke(60_500).Rotate()
	if !window.Accepts(3, 60_999) || !window.Accepts(2, 60_999) || window.Accepts(2, 61_000) {
		t.Fatal("retry or rotation extended the original cutoff")
	}
	window = window.Revoke(60_600).Rotate()
	serialized, err := json.Marshal(window)
	if err != nil {
		t.Fatal(err)
	}
	var restored EpochWindow
	if err := json.Unmarshal(serialized, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Accepts(2, 60_800) || !restored.Accepts(3, 120_599) ||
		restored.Accepts(3, 120_600) || !restored.Accepts(4, 120_600) {
		t.Fatal("later rotation must restrict older generations and preserve deadlines across restore")
	}
}

func TestRotationWithoutGrace(t *testing.T) {
	window := EpochWindow{Current: 1}.Rotate()
	if window.Accepts(1, 1) || !window.Accepts(2, 1) || window.Accepts(0, 1) {
		t.Fatal("rotation without revoke must not open a grace window")
	}
}
