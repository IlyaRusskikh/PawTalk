package main

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type profileProof struct {
	Key       string `json:"key"`
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

func (a *app) signChallenge(value string) string {
	mac := hmac.New(sha256.New, []byte(a.cfg.APISecret))
	mac.Write([]byte("voicecord-profile-v1:" + value))
	return b64.EncodeToString(mac.Sum(nil))
}

func (a *app) roomConfig(w http.ResponseWriter, _ *http.Request) {
	result := map[string]any{"e2eeRequired": a.cfg.RequireE2EE}
	if a.chat != nil {
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			fail(w, 503, "Profile challenge unavailable")
			return
		}
		challenge := strconv.FormatInt(a.now().Unix()+60, 10) + "." + b64.EncodeToString(nonce[:])
		result["profileChallenge"] = challenge + "." + a.signChallenge(challenge)
	}
	respond(w, 200, result)
}

func (a *app) verifyProfile(p profileProof, nickname string) (string, bool) {
	fields := strings.Split(p.Challenge, ".")
	if len(fields) != 3 || len(fields[1]) != 22 {
		return "", false
	}
	now := a.now().Unix()
	expires, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || expires <= now || expires > now+60 || !hmac.Equal([]byte(fields[2]), []byte(a.signChallenge(fields[0]+"."+fields[1]))) {
		return "", false
	}
	key, errKey := b64.DecodeString(p.Key)
	signature, errSignature := b64.DecodeString(p.Signature)
	if errKey != nil || errSignature != nil || len(key) != ed25519.PublicKeySize ||
		!ed25519.Verify(key, []byte("voicecord-profile-v1\n"+p.Challenge+"\n"+nickname), signature) {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, until := range a.usedChallenges {
		if until <= now {
			delete(a.usedChallenges, key)
		}
	}
	if a.usedChallenges[p.Challenge] != 0 || len(a.usedChallenges) >= 4096 {
		return "", false
	}
	if a.usedChallenges == nil {
		a.usedChallenges = make(map[string]int64)
	}
	a.usedChallenges[p.Challenge] = expires
	digest := sha256.Sum256(key)
	return hex.EncodeToString(digest[:]), true
}

func validNickname(name string) bool {
	length := utf8.RuneCountInString(name)
	return utf8.ValidString(name) && length >= 1 && length <= 32 && strings.IndexFunc(name, unicode.IsControl) < 0
}
