package access

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
)

var ErrRecoveryCoverageChanged = errors.New("protected recovery coverage changed")
var ErrInvalidRecoveryOpeningProof = errors.New("invalid protected recovery package opening proof")

type RecoveryEvidenceQuery interface {
	SessionQuery
	epochDeliveryQuery
}

// VerifyRecoveryConfirmationEvidence verifies a complete set of package
// opening proofs while the caller holds the policy transaction. History
// replay checks the witnessed generations from the previous signed policy.
func VerifyRecoveryConfirmationEvidence(ctx context.Context, query RecoveryEvidenceQuery, state State,
	actor Principal, head PolicyProof, serverID string, confirmation RecoveryPolicyConfirmation,
	verify VerifyEpochRecord, now int64, current bool) error {
	if verify == nil || !validRotationID(serverID) || !isDigest(head.Digest) || head.Draft.Revision <= 0 ||
		!isDigest(confirmation.CutoverDigest) || !isDigest(confirmation.Nonce) ||
		confirmation.ExpiresAt <= 0 || confirmation.ExpiresAt > maxInviteDate {
		return InvalidAction
	}
	if current && now >= confirmation.ExpiresAt {
		return ErrRecoveryChallengeExpired
	}
	if !current {
		// Signed snapshots omit operational epoch windows and the anchor flag.
		state.PolicyAnchored = true
		now = confirmation.ExpiresAt - 1
	}
	identity, err := currentRecoveryIdentity(state, actor, now)
	if err != nil {
		return err
	}
	digest, err := state.PolicyDigest()
	if err != nil || digest != head.Draft.ResultDigest {
		return ErrPolicyConflict
	}
	if identity.ID == "" || identity.ID != confirmation.RecoveryID ||
		confirmation.Items == nil || len(confirmation.Items) > maxRecoveryCoverageItems {
		return ErrRecoveryCoverageChanged
	}
	if err := checkRecoveryConfirmationScope(state, actor.ProfileID, confirmation.Items); err != nil {
		return err
	}
	recoveryKey, err := hex.DecodeString(identity.SigningKey)
	if err != nil || len(recoveryKey) != ed25519.PublicKeySize {
		return ErrInvalidRecoveryOpeningProof
	}
	basis := recoveryEpochBasis{revision: head.Draft.Revision, digest: digest, state: state}
	usedOpeningKeys := make(map[[RecoveryEpochOpeningKeySize]byte]struct{}, len(confirmation.Items))
	for _, item := range confirmation.Items {
		target := RecoveryCoverageItem{ChannelID: item.ChannelID, Purpose: item.Purpose, Generation: item.Generation}
		if item.Generation == 0 || current && (state.currentGeneration(item.ChannelID, item.Purpose) != item.Generation ||
			item.Purpose == LiveEpoch && !state.EpochWindows[item.ChannelID].Accepts(item.Generation, now)) {
			return ErrRecoveryCoverageChanged
		}
		packet, err := readRecoveryEpochWitness(ctx, query, state, actor.ProfileID, identity, target, &basis)
		if err != nil {
			return err
		}
		if packet.packageDigest == "" || packet.epoch.Record.Revision > head.Draft.Revision ||
			packet.epochDigest != item.EpochDigest || packet.packageDigest != item.PackageDigest ||
			hex.EncodeToString(packet.openingKey[:]) != item.OpeningKey {
			return ErrRecoveryCoverageChanged
		}
		if _, used := usedOpeningKeys[packet.openingKey]; used {
			return ErrRecoveryCoverageChanged
		}
		usedOpeningKeys[packet.openingKey] = struct{}{}
		if err := verifyRecoveryOpeningProof(serverID, actor, head.Digest, confirmation, item, packet.openingKey, recoveryKey); err != nil {
			return err
		}
		if err := verify(ctx, query, packet.epoch.Principal, packet.epoch.Record); err != nil {
			return err
		}
		// Verify inclusion in the signed package root. The exact recipient
		// row read above and the inclusion query share the same transaction.
		if _, err := readOwnEpochPackage(ctx, query, identity.ID, identity.AgreementKey, packet.epoch); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func verifyRecoveryOpeningProof(serverID string, actor Principal, previous string, confirmation RecoveryPolicyConfirmation,
	item RecoveryReadyItem, publicKey [RecoveryEpochOpeningKeySize]byte, recoveryKey ed25519.PublicKey) error {
	proofLength := base64.RawURLEncoding.EncodedLen(ed25519.SignatureSize)
	if len(item.OpeningProof) != proofLength || len(item.RecoveryProof) != proofLength {
		return ErrInvalidRecoveryOpeningProof
	}
	openingProof, openingErr := base64.RawURLEncoding.Strict().DecodeString(item.OpeningProof)
	recoveryProof, recoveryErr := base64.RawURLEncoding.Strict().DecodeString(item.RecoveryProof)
	if openingErr != nil || recoveryErr != nil {
		return ErrInvalidRecoveryOpeningProof
	}
	frame, err := SignatureFrame("pawtalk-protected-recovery-package-open-v1", serverID, confirmation.CutoverDigest,
		actor.ProfileID, actor.DeviceID, confirmation.RecoveryID, previous, item.ChannelID, item.Purpose,
		strconv.FormatUint(item.Generation, 10), item.EpochDigest, item.PackageDigest, confirmation.Nonce, strconv.FormatInt(confirmation.ExpiresAt, 10))
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey[:], frame, openingProof) || !ed25519.Verify(recoveryKey, frame, recoveryProof) {
		return ErrInvalidRecoveryOpeningProof
	}
	return nil
}
