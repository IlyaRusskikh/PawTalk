package access

import "context"

// ReadMigrationRecoveryEpochPackage exposes only the signed initial runtime
// recovery packet. The migration transport authenticates the staged owner.
func ReadMigrationRecoveryEpochPackage(ctx context.Context, query RecoveryEvidenceQuery, actor Principal,
	channel, purpose, key string, verify VerifyEpochRecord) (EpochPackageDelivery, error) {
	var result EpochPackageDelivery
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || !isDigest(key) || verify == nil {
		return result, InvalidAction
	}
	state, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return result, err
	}
	if revision != 1 || actor.ProfileID != state.Owner || !state.canUseDevice(actor) ||
		!state.canLoadEpoch(actor, channel, purpose) {
		return result, ChannelRestricted
	}
	identity, err := currentRecoveryIdentity(state, actor, 0)
	if err != nil {
		return result, err
	}
	if identity.ID == "" || state.currentGeneration(channel, purpose) != 1 {
		return result, ErrEpochRecipients
	}
	head, err := ReadPolicyHead(ctx, query, &actor)
	if err != nil {
		return result, err
	}
	epoch, err := readEpoch(ctx, query, channel, purpose, key)
	if err != nil {
		return result, err
	}
	if epoch.Principal != actor || epoch.Record.Generation != 1 || epoch.Record.Revision != revision ||
		epoch.Record.PolicyDigest != head.Draft.ResultDigest {
		return result, ErrEpochConflict
	}
	if err := verify(ctx, query, actor, epoch.Record); err != nil {
		return result, err
	}
	result, err = readOwnEpochPackage(ctx, query, identity.ID, identity.AgreementKey, epoch)
	if err != nil {
		return EpochPackageDelivery{}, err
	}
	ciphertext := result.Package.Ciphertext
	if len(ciphertext) != RecoveryEpochPackageSize || !ValidRecoveryEpochOpeningKey(ciphertext[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:]) {
		return EpochPackageDelivery{}, ErrEpochRecipients
	}
	return result, nil
}
