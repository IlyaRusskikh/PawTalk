package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func checkProtectedRecoveryEnrollment(t *testing.T, db *sql.DB,
	request func(method, path, token string, input any, status int, output any),
	owner, member protectedSessionReceipt, device ed25519.PrivateKey, expireChallenge func()) protectedRecoveryProposal {
	t.Helper()
	const challengePath = "/api/v3/recovery/challenge"
	const enrollPath = "/api/v3/recovery/enroll"
	request(http.MethodPost, challengePath, "", struct{}{}, http.StatusUnauthorized, nil)
	makeProposal := func(operation string, seed byte, validAgreement bool) protectedRecoveryProposal {
		t.Helper()
		var challenge protectedRecoveryChallenge
		request(http.MethodPost, challengePath, member.Token, struct{}{}, http.StatusOK, &challenge)
		if challenge.ProfileID != member.ProfileID || challenge.DeviceID != member.DeviceID {
			t.Fatal("challenge did not bind the active member")
		}
		signing := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, ed25519.SeedSize))
		agreement, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{seed + 1}, 32))
		if err != nil {
			t.Fatal(err)
		}
		proposal := protectedRecoveryProposal{OperationID: operation, PolicyHead: challenge.PolicyHead,
			Nonce: challenge.Nonce, ExpiresAt: challenge.ExpiresAt, SigningKey: hex.EncodeToString(signing.Public().(ed25519.PublicKey)),
			AgreementKey: hex.EncodeToString(agreement.PublicKey().Bytes())}
		recoveryID, err := recoveryIdentityID(challenge.ServerID, member.ProfileID, proposal.SigningKey, proposal.AgreementKey)
		if err != nil {
			t.Fatal(err)
		}
		transcript, err := signatureFrame("pawtalk-protected-recovery-enrollment-v1", challenge.ServerID, challenge.CutoverDigest,
			member.ProfileID, member.DeviceID, operation, challenge.PolicyHead, challenge.Nonce, strconv.FormatInt(challenge.ExpiresAt, 10),
			recoveryID, proposal.SigningKey, proposal.AgreementKey, challenge.ServerAgreementKey)
		if err != nil {
			t.Fatal(err)
		}
		proposal.RecoveryProof = b64.EncodeToString(ed25519.Sign(signing, transcript))
		raw, err := hex.DecodeString(challenge.ServerAgreementKey)
		if err != nil {
			t.Fatal(err)
		}
		serverPublic, err := ecdh.X25519().NewPublicKey(raw)
		if err != nil {
			t.Fatal(err)
		}
		shared, err := agreement.ECDH(serverPublic)
		if err != nil {
			t.Fatal(err)
		}
		if !validAgreement {
			clear(shared)
		}
		mac := hmac.New(sha256.New, shared)
		clear(shared)
		mac.Write(transcript)
		proposal.AgreementProof = b64.EncodeToString(mac.Sum(nil))
		frame, err := signatureFrame("pawtalk-protected-recovery-device-v1", publicKeyID(transcript), proposal.RecoveryProof, proposal.AgreementProof)
		if err != nil {
			t.Fatal(err)
		}
		proposal.DeviceProof = b64.EncodeToString(ed25519.Sign(device, frame))
		return proposal
	}
	invalid := makeProposal(strings.Repeat("4", 32), 35, false)
	request(http.MethodPost, enrollPath, member.Token, invalid, http.StatusForbidden, nil)
	first := makeProposal(strings.Repeat("5", 32), 37, true)
	request(http.MethodPost, enrollPath, owner.Token, first, http.StatusForbidden, nil)
	var firstResponse map[string]any
	request(http.MethodPost, enrollPath, member.Token, first, http.StatusOK, &firstResponse)
	enrollment, err := access.ReadPolicyHead(context.Background(), db, nil)
	if err != nil {
		t.Fatal(err)
	}
	if enrollment.Principal.ProfileID != member.ProfileID || enrollment.Principal.DeviceID != member.DeviceID ||
		enrollment.Draft.PreviousDigest != first.PolicyHead || enrollment.Draft.ResourceChange.Recovery.AgreementKey != first.AgreementKey {
		t.Fatal("recovery proof did not bind the accepted proposal")
	}
	if len(firstResponse) != 4 || firstResponse["operationId"] != first.OperationID ||
		firstResponse["recoveryId"] != enrollment.Draft.ResourceChange.Recovery.RecoveryID ||
		firstResponse["revision"] != float64(enrollment.Draft.Revision) || firstResponse["digest"] != enrollment.Digest {
		t.Fatal("enrollment receipt must match the proof without disclosing the policy draft")
	}
	var replacement protectedRecoveryReceipt
	second := makeProposal(strings.Repeat("6", 32), 39, true)
	request(http.MethodPost, enrollPath, member.Token, second, http.StatusOK, &replacement)
	var retired struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	request(http.MethodPost, enrollPath, member.Token, makeProposal(strings.Repeat("9", 32), 37, true), http.StatusConflict, &retired)
	if retired.Error.Code != "PROTECTED_RECOVERY_KIT_RETIRED" {
		t.Fatalf("retired recovery enrollment must return an actionable error: %q", retired.Error.Code)
	}
	expired := makeProposal(strings.Repeat("7", 32), 41, true)
	expireChallenge()
	request(http.MethodPost, enrollPath, member.Token, expired, http.StatusUnauthorized, nil)
	var retry protectedRecoveryReceipt
	request(http.MethodPost, enrollPath, member.Token, first, http.StatusOK, &retry)
	head, err := access.ReadPolicyHead(context.Background(), db, nil)
	if err != nil {
		t.Fatal(err)
	}
	if retry.Digest != enrollment.Digest || head.Digest != replacement.Digest || head.Draft.PreviousDigest != enrollment.Digest {
		t.Fatal("recovery retry did not preserve the original receipt")
	}
	var raw []byte
	if err := db.QueryRow("SELECT snapshot FROM protected_policy WHERE id=1").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var state access.State
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	oldID := enrollment.Draft.ResourceChange.Recovery.RecoveryID
	nextID := replacement.RecoveryID
	if state.KeyRecipients[oldID].Kind != "" || !state.RetiredRecipientKeys[first.AgreementKey] ||
		state.KeyRecipients[nextID].PublicKey != second.AgreementKey || state.KeyRecipients[nextID].Kind != "recovery" ||
		state.RecoveryReady[member.ProfileID] {
		t.Fatal("replacement must preserve only the pending new recovery recipient")
	}
	return second
}
