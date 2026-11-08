package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEncryptionRequiredAndKeyCommitment(t *testing.T) {
	a := testApp(t)
	a.cfg.RequireE2EE = true
	a.cfg.E2EEKeyID = strings.Repeat("a", 64)
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"nickname":"old-client","password":"test-password"}`, 426},
		{`{"nickname":"no-key","password":"test-password","e2ee":true}`, 426},
		{`{"nickname":"wrong-key","password":"test-password","e2ee":true,"e2eeKeyId":"` + strings.Repeat("b", 64) + `"}`, 403},
		{`{"nickname":"encrypted","password":"test-password","e2ee":true,"e2eeKeyId":"` + strings.Repeat("a", 64) + `"}`, 200},
	} {
		w := request(a, tc.body)
		if w.Code != tc.code {
			t.Fatalf("got %d want %d: %s", w.Code, tc.code, w.Body)
		}
		if tc.code == 200 && !strings.Contains(w.Body.String(), `"e2eeRequired":true`) {
			t.Fatal("policy omitted")
		}
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/config", nil))
	if !strings.Contains(w.Body.String(), `"e2eeRequired":true`) {
		t.Fatal("policy discovery failed")
	}
}

func TestEncryptionEnvironment(t *testing.T) {
	t.Setenv("PAWTALK_E2EE", "tru")
	if _, _, err := encryptionPolicy(); err == nil {
		t.Fatal("invalid boolean accepted")
	}
	t.Setenv("PAWTALK_E2EE", "true")
	t.Setenv("PAWTALK_E2EE_KEY_ID", "short")
	if _, _, err := encryptionPolicy(); err == nil {
		t.Fatal("invalid key id accepted")
	}
	t.Setenv("PAWTALK_E2EE_KEY_ID", strings.Repeat("a", 64))
	if required, _, err := encryptionPolicy(); err != nil || !required {
		t.Fatal("valid policy rejected")
	}
}
