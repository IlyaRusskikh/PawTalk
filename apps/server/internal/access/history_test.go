package access

import "testing"

func TestAdmissionHistory(t *testing.T) {
	admission := (Admission{}).Update(true, 10)
	if admission.CanRead(9, false) || !admission.CanRead(9, true) || !admission.CanRead(10, false) {
		t.Fatal("incorrect initial history boundary")
	}
	admission = admission.Update(true, 20)
	if admission.CanRead(9, false) || !admission.CanRead(10, false) {
		t.Fatal("continuous grant changed original boundary")
	}
	admission = admission.Update(false, 21)
	if admission.CanRead(10, true) {
		t.Fatal("revoked profile retains full history access")
	}
	admission = admission.Update(true, 30)
	if admission.CanRead(29, false) || !admission.CanRead(30, false) || !admission.CanRead(10, true) {
		t.Fatal("readmission failed to start a new interval")
	}
}
