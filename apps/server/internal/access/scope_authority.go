package access

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
)

const (
	AuthorizeScopeRecovery    = "recovery.authorize"
	TransferScopeOwner        = "owner.transfer"
	MoveScopeDevice           = "scope.device"
	maxScopeAuthorityRevision = 1<<53 - 1
)

var ErrScopeAuthority = errors.New("invalid protected scope authority chain")

type ScopeAuthorityContext struct {
	ServerID       string
	CutoverDigest  string
	AnchorDigest   string
	OwnerProfileID string
	OwnerDeviceID  string
}

type ScopeAuthorityLink struct {
	Sequence        int64                `json:"sequence"`
	Previous        string               `json:"previous"`
	Action          string               `json:"action"`
	Revision        int64                `json:"revision"`
	PolicyHead      string               `json:"policyHead"`
	OperationID     string               `json:"operationId"`
	RecoveryID      string               `json:"recoveryId"`
	RecoveryKey     string               `json:"recoveryKey"`
	DeviceKey       string               `json:"deviceKey"`
	Authorization   string               `json:"authorization"`
	DeviceProof     string               `json:"deviceProof,omitempty"`
	TargetProfileID string               `json:"targetProfileId,omitempty"`
	Transfer        *ScopeOwnershipClaim `json:"transfer,omitempty"`
	SourceDeviceID  string               `json:"sourceDeviceId,omitempty"`
	ExpiresAt       int64                `json:"expiresAt,omitempty"`
}

type ScopeAuthorityState struct {
	OwnershipTransferred bool
	SignerMoved          bool
	Sequence             int64
	Revision             int64
	Digest               string
	DeviceID             string
	DeviceKey            string
	RecoveryID           string
	RecoveryKey          string
	OwnerProfileID       string
}

func (binding ScopeAuthorityContext) valid() bool {
	return validRotationID(binding.ServerID) && isDigest(binding.CutoverDigest) && isDigest(binding.AnchorDigest) &&
		isDigest(binding.OwnerProfileID) && isDigest(binding.OwnerDeviceID)
}

func ScopeAuthorityLinkFrame(binding ScopeAuthorityContext, link ScopeAuthorityLink) ([]byte, error) {
	if !validScopeAuthorityLinkFields(binding, link) || link.TargetProfileID != "" || link.Transfer != nil || !isDigest(link.DeviceKey) ||
		link.SourceDeviceID != "" || link.ExpiresAt != 0 || !isDigest(link.RecoveryID) || !isDigest(link.RecoveryKey) ||
		(link.Revision < 2 && !isDetachedScopeGenesis(binding, link)) ||
		(link.Action != AuthorizeScopeRecovery && link.Action != RecoverPolicyDevice) {
		return nil, ErrScopeAuthority
	}
	return SignatureFrame("pawtalk-scope-authority-link-v1", binding.ServerID, binding.CutoverDigest,
		binding.AnchorDigest, binding.OwnerProfileID, strconv.FormatInt(link.Sequence, 10), link.Previous,
		link.Action, strconv.FormatInt(link.Revision, 10), link.PolicyHead, link.OperationID, link.RecoveryID,
		link.RecoveryKey, link.DeviceKey)
}

func validScopeAuthorityLinkFields(binding ScopeAuthorityContext, link ScopeAuthorityLink) bool {
	return binding.valid() && link.Sequence >= 1 && link.Sequence <= maxScopeAuthorityRevision &&
		link.Revision <= maxScopeAuthorityRevision && isDigest(link.Previous) && isDigest(link.PolicyHead) &&
		validRotationID(link.OperationID)
}

func ScopeOwnershipOfferFrame(binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink) ([]byte, error) {
	claim := link.Transfer
	if !validScopeAuthorityLinkFields(binding, link) || link.Action != TransferScopeOwner || link.Revision < 2 ||
		!isDigest(currentOwner) || !isDigest(link.TargetProfileID) || link.TargetProfileID == currentOwner || claim == nil ||
		link.SourceDeviceID != "" || link.ExpiresAt != 0 || !isDigest(link.RecoveryID) || !isDigest(link.RecoveryKey) ||
		claim.CutoverDigest != binding.CutoverDigest || claim.ExpiresAt < 1 || claim.ExpiresAt > maxInviteDate || !isDigest(claim.CandidatesRoot) {
		return nil, ErrScopeAuthority
	}
	return SignatureFrame("pawtalk-scope-owner-transfer-offer-v1", binding.ServerID, binding.CutoverDigest,
		binding.AnchorDigest, currentOwner, strconv.FormatInt(link.Sequence, 10), link.Previous,
		strconv.FormatInt(link.Revision, 10), link.PolicyHead, link.OperationID, link.TargetProfileID,
		link.RecoveryID, link.RecoveryKey, strconv.FormatInt(claim.ExpiresAt, 10), claim.CandidatesRoot)
}

func ScopeOwnershipAcceptFrame(binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink) ([]byte, error) {
	frame, err := ScopeOwnershipOfferFrame(binding, currentOwner, link)
	if err != nil || !isDigest(link.DeviceKey) || !validRecoveryProof(link.Authorization, ed25519.SignatureSize) {
		return nil, ErrScopeAuthority
	}
	return scopeOwnershipAcceptFrame(hexHash(frame), link)
}

func scopeOwnershipAcceptFrame(offerDigest string, link ScopeAuthorityLink) ([]byte, error) {
	return SignatureFrame("pawtalk-scope-owner-transfer-accept-v1", offerDigest, link.Authorization, link.TargetProfileID, link.DeviceKey)
}

func ScopeDeviceHandoverFrame(binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink) ([]byte, error) {
	if !validScopeAuthorityLinkFields(binding, link) || link.Action != MoveScopeDevice || link.Revision < 2 ||
		!isDigest(currentOwner) || !isDigest(link.SourceDeviceID) || link.TargetProfileID != "" || link.Transfer != nil ||
		link.ExpiresAt < 1 || link.ExpiresAt > maxInviteDate {
		return nil, ErrScopeAuthority
	}
	deviceKey := parseScopeAuthorityKey(link.DeviceKey)
	if deviceKey == nil {
		return nil, ErrScopeAuthority
	}
	deviceID := hexHash(deviceKey)
	if deviceID == link.SourceDeviceID ||
		((link.RecoveryID != "" || link.RecoveryKey != "") &&
			(!isDigest(link.RecoveryID) || parseScopeAuthorityKey(link.RecoveryKey) == nil || link.RecoveryKey == link.DeviceKey)) {
		return nil, ErrScopeAuthority
	}
	return SignatureFrame("pawtalk-scope-device-handover-v1", binding.ServerID, binding.CutoverDigest,
		binding.AnchorDigest, currentOwner, strconv.FormatInt(link.Sequence, 10), link.Previous,
		strconv.FormatInt(link.Revision, 10), link.PolicyHead, link.OperationID, link.SourceDeviceID,
		deviceID, link.DeviceKey, link.RecoveryID, link.RecoveryKey, strconv.FormatInt(link.ExpiresAt, 10))
}

func ScopeDeviceHandoverConsentFrame(binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink) ([]byte, error) {
	frame, err := ScopeDeviceHandoverFrame(binding, currentOwner, link)
	if err != nil || !validRecoveryProof(link.Authorization, ed25519.SignatureSize) {
		return nil, ErrScopeAuthority
	}
	return scopeDeviceHandoverConsentFrame(hexHash(frame), link.Authorization)
}

func scopeDeviceHandoverConsentFrame(frameDigest, authorization string) ([]byte, error) {
	return SignatureFrame("pawtalk-scope-device-handover-accept-v1", frameDigest, authorization)
}

func ScopeDeviceHandoverLinkDigest(binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink) (string, error) {
	frame, err := ScopeDeviceHandoverFrame(binding, currentOwner, link)
	if err != nil || !link.validProofs() {
		return "", ErrScopeAuthority
	}
	return scopeAuthorityLinkDigest(hexHash(frame), link)
}

func isDetachedScopeGenesis(binding ScopeAuthorityContext, link ScopeAuthorityLink) bool {
	return link.Sequence == 1 && link.Revision == 1 && link.Action == AuthorizeScopeRecovery &&
		link.Previous == binding.AnchorDigest && link.PolicyHead == binding.AnchorDigest
}

func ScopeAuthorityDeviceConsentFrame(binding ScopeAuthorityContext, link ScopeAuthorityLink) ([]byte, error) {
	frame, err := ScopeAuthorityLinkFrame(binding, link)
	if err != nil || link.Action != RecoverPolicyDevice || !validRecoveryProof(link.Authorization, ed25519.SignatureSize) {
		return nil, ErrScopeAuthority
	}
	return scopeAuthorityDeviceConsentFrame(hexHash(frame), link.Authorization)
}

func scopeAuthorityDeviceConsentFrame(frameDigest, authorization string) ([]byte, error) {
	return SignatureFrame("pawtalk-scope-authority-device-consent-v1", frameDigest, authorization)
}

func ScopeAuthorityLinkDigest(binding ScopeAuthorityContext, link ScopeAuthorityLink) (string, error) {
	frame, err := ScopeAuthorityLinkFrame(binding, link)
	if err != nil || !link.validProofs() {
		return "", ErrScopeAuthority
	}
	return scopeAuthorityLinkDigest(hexHash(frame), link)
}

func ScopeOwnershipLinkDigest(binding ScopeAuthorityContext, currentOwner string, link ScopeAuthorityLink) (string, error) {
	frame, err := ScopeOwnershipOfferFrame(binding, currentOwner, link)
	if err != nil || !link.validProofs() || !link.Transfer.proves(link.DeviceKey) {
		return "", ErrScopeAuthority
	}
	return scopeAuthorityLinkDigest(hexHash(frame), link)
}

func scopeAuthorityLinkDigest(frameDigest string, link ScopeAuthorityLink) (string, error) {
	frame, err := SignatureFrame("pawtalk-scope-authority-link-digest-v1", frameDigest, link.Authorization, link.DeviceProof)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func (link ScopeAuthorityLink) validProofs() bool {
	if !validRecoveryProof(link.Authorization, ed25519.SignatureSize) {
		return false
	}
	if link.Action == AuthorizeScopeRecovery {
		return link.DeviceProof == ""
	}
	return validRecoveryProof(link.DeviceProof, ed25519.SignatureSize)
}

// VerifyScopeAuthorityChain validates a linear chain starting at the pinned
// owner device. A caller that has accepted an earlier head must also compare
// its saved digest with the corresponding prefix to detect rollback or forks.
func VerifyScopeAuthorityChain(binding ScopeAuthorityContext, genesisDeviceKey string, links []ScopeAuthorityLink) (ScopeAuthorityState, error) {
	deviceKey := parseScopeAuthorityKey(genesisDeviceKey)
	if !binding.valid() || deviceKey == nil || hexHash(deviceKey) != binding.OwnerDeviceID {
		return ScopeAuthorityState{}, ErrScopeAuthority
	}
	state := ScopeAuthorityState{Revision: 1, Digest: binding.AnchorDigest, DeviceID: binding.OwnerDeviceID, DeviceKey: genesisDeviceKey,
		OwnerProfileID: binding.OwnerProfileID}
	var recoveryKey ed25519.PublicKey
	usedKeys := map[string]bool{genesisDeviceKey: true}
	usedRecoveryIDs := make(map[string]bool)
	retiredKeys := make(map[string]bool)
	retiredRecoveryIDs := make(map[string]bool)
	usedOperations := make(map[string]bool)
	for _, link := range links {
		var frame []byte
		var err error
		switch link.Action {
		case TransferScopeOwner:
			frame, err = ScopeOwnershipOfferFrame(binding, state.OwnerProfileID, link)
		case MoveScopeDevice:
			frame, err = ScopeDeviceHandoverFrame(binding, state.OwnerProfileID, link)
		default:
			frame, err = ScopeAuthorityLinkFrame(binding, link)
		}
		if err != nil || !link.validProofs() || link.Sequence != state.Sequence+1 || link.Previous != state.Digest ||
			(link.Revision <= state.Revision && !(state.Sequence == 0 && isDetachedScopeGenesis(binding, link))) || usedOperations[link.OperationID] {
			return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, state.Sequence+1)
		}
		frameDigest := hexHash(frame)
		switch link.Action {
		case AuthorizeScopeRecovery:
			newRecoveryKey := parseScopeAuthorityKey(link.RecoveryKey)
			if link.DeviceKey != state.DeviceKey || usedKeys[link.RecoveryKey] || usedRecoveryIDs[link.RecoveryID] ||
				newRecoveryKey == nil || !verifyScopeAuthoritySignature(deviceKey, frame, link.Authorization) {
				return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, link.Sequence)
			}
			if state.RecoveryKey != "" {
				retiredKeys[state.RecoveryKey], retiredRecoveryIDs[state.RecoveryID] = true, true
			}
			recoveryKey, state.RecoveryKey, state.RecoveryID = newRecoveryKey, link.RecoveryKey, link.RecoveryID
			usedKeys[link.RecoveryKey], usedRecoveryIDs[link.RecoveryID] = true, true
		case RecoverPolicyDevice:
			newDeviceKey := parseScopeAuthorityKey(link.DeviceKey)
			consent, err := scopeAuthorityDeviceConsentFrame(frameDigest, link.Authorization)
			if recoveryKey == nil || link.RecoveryID != state.RecoveryID || link.RecoveryKey != state.RecoveryKey ||
				usedKeys[link.DeviceKey] || newDeviceKey == nil || err != nil ||
				!verifyScopeAuthoritySignature(recoveryKey, frame, link.Authorization) ||
				!verifyScopeAuthoritySignature(newDeviceKey, consent, link.DeviceProof) {
				return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, link.Sequence)
			}
			retiredKeys[state.DeviceKey] = true
			deviceKey, state.DeviceKey, state.DeviceID = newDeviceKey, link.DeviceKey, hexHash(newDeviceKey)
			usedKeys[link.DeviceKey] = true
		case TransferScopeOwner:
			newDeviceKey, newRecoveryKey := parseScopeAuthorityKey(link.DeviceKey), parseScopeAuthorityKey(link.RecoveryKey)
			consent, err := scopeOwnershipAcceptFrame(frameDigest, link)
			if err != nil || newDeviceKey == nil || newRecoveryKey == nil || link.DeviceKey == state.DeviceKey ||
				link.RecoveryKey == state.RecoveryKey || link.RecoveryID == state.RecoveryID || link.RecoveryKey == link.DeviceKey ||
				link.DeviceKey == state.RecoveryKey || link.RecoveryKey == state.DeviceKey ||
				retiredKeys[link.DeviceKey] || retiredKeys[link.RecoveryKey] || retiredRecoveryIDs[link.RecoveryID] ||
				!link.Transfer.proves(link.DeviceKey) || !verifyScopeAuthoritySignature(deviceKey, frame, link.Authorization) ||
				!verifyScopeAuthoritySignature(newDeviceKey, consent, link.DeviceProof) {
				return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, link.Sequence)
			}
			deviceKey, state.DeviceKey, state.DeviceID = newDeviceKey, link.DeviceKey, hexHash(newDeviceKey)
			recoveryKey, state.RecoveryKey, state.RecoveryID = newRecoveryKey, link.RecoveryKey, link.RecoveryID
			state.OwnerProfileID = link.TargetProfileID
			state.OwnershipTransferred = true
			usedKeys[link.DeviceKey], usedKeys[link.RecoveryKey], usedRecoveryIDs[link.RecoveryID] = true, true, true
		case MoveScopeDevice:
			newDeviceKey := parseScopeAuthorityKey(link.DeviceKey)
			consent, err := scopeDeviceHandoverConsentFrame(frameDigest, link.Authorization)
			if err != nil || link.SourceDeviceID != state.DeviceID || newDeviceKey == nil || link.DeviceKey == state.RecoveryKey ||
				retiredKeys[link.DeviceKey] || !verifyScopeAuthoritySignature(deviceKey, frame, link.Authorization) ||
				!verifyScopeAuthoritySignature(newDeviceKey, consent, link.DeviceProof) {
				return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, link.Sequence)
			}
			if state.RecoveryID == "" && link.RecoveryID != "" {
				// The full policy verifier must match this initial pair against
				// the enrolled recovery identity immediately before the handover.
				newRecoveryKey := parseScopeAuthorityKey(link.RecoveryKey)
				if newRecoveryKey == nil || usedKeys[link.RecoveryKey] || usedRecoveryIDs[link.RecoveryID] {
					return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, link.Sequence)
				}
				recoveryKey, state.RecoveryID, state.RecoveryKey = newRecoveryKey, link.RecoveryID, link.RecoveryKey
				usedKeys[link.RecoveryKey], usedRecoveryIDs[link.RecoveryID] = true, true
			} else if link.RecoveryID != state.RecoveryID || link.RecoveryKey != state.RecoveryKey {
				return ScopeAuthorityState{}, fmt.Errorf("%w at sequence %d", ErrScopeAuthority, link.Sequence)
			}
			deviceKey, state.DeviceKey, state.DeviceID = newDeviceKey, link.DeviceKey, hexHash(newDeviceKey)
			state.SignerMoved = true
			usedKeys[link.DeviceKey] = true
		}
		state.Digest, err = scopeAuthorityLinkDigest(frameDigest, link)
		if err != nil {
			return ScopeAuthorityState{}, err
		}
		state.Sequence, state.Revision = link.Sequence, link.Revision
		usedOperations[link.OperationID] = true
	}
	return state, nil
}

func verifyScopeAuthoritySignature(key ed25519.PublicKey, frame []byte, encoded string) bool {
	signature, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	return err == nil && ed25519.Verify(key, frame, signature)
}

var scopeAuthorityField = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))

func parseScopeAuthorityKey(encoded string) ed25519.PublicKey {
	if !isDigest(encoded) {
		return nil
	}
	key, err := hex.DecodeString(encoded)
	if err != nil || !ValidRecoveryEpochOpeningKey(key) {
		return nil
	}
	// Ed25519 encodes y in little endian, with the high bit holding x's sign.
	// An authorization may introduce a recovery key before it signs anything,
	// so verify that its canonical y-coordinate can represent a curve point.
	var bigEndian [ed25519.PublicKeySize]byte
	for index, value := range key {
		bigEndian[len(bigEndian)-1-index] = value
	}
	bigEndian[0] &= 0x7f
	y := new(big.Int).SetBytes(bigEndian[:])
	ySquared := new(big.Int).Mul(y, y)
	numerator := new(big.Int).Sub(ySquared, big.NewInt(1))
	numerator.Mul(numerator, big.NewInt(121666))
	denominator := new(big.Int).Mul(ySquared, big.NewInt(-121665))
	denominator.Add(denominator, big.NewInt(121666))
	// Multiplication and division by a nonzero denominator have the same
	// quadratic character. A zero numerator or denominator also fails here.
	if big.Jacobi(numerator.Mul(numerator, denominator), scopeAuthorityField) != 1 {
		return nil
	}
	return key
}
