package access

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTextGroupedRotationProjectionVectors(t *testing.T) {
	channel := strings.Repeat("9", 32)
	owner, reader := strings.Repeat("1", 64), strings.Repeat("2", 64)
	recoveryID := strings.Repeat("4", 64)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Roles: map[string]Role{Everyone: {Grants: []string{ChannelView}}}},
			Members: map[string]Subject{
				owner: {ID: owner, Active: true}, reader: {ID: reader, Active: true},
			},
		},
		Channels: map[string]Channel{channel: {Kind: "text", NextPosition: 5}},
		Admissions: map[string]map[string]Admission{channel: {
			owner: {FirstPosition: 1}, reader: {FirstPosition: 4},
		}},
		KeyRecipients: map[string]KeyRecipient{
			recoveryID: {ProfileID: owner, Kind: "recovery", PublicKey: strings.Repeat("d", 64)},
		},
		PolicyDevices: make(map[string]PolicyDevice),
	}
	for _, device := range []struct {
		seed           byte
		profile, agree string
	}{{1, owner, "a"}, {2, owner, "b"}, {3, reader, "c"}} {
		signingKey := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(device.seed))
		id := hexHash(parseScopeAuthorityKey(signingKey))
		state.PolicyDevices[id] = PolicyDevice{ProfileID: device.profile, PublicKey: signingKey}
		state.KeyRecipients[id] = KeyRecipient{ProfileID: device.profile, Kind: "device", PublicKey: strings.Repeat(device.agree, 64)}
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	current, err := state.textRecipientCommitment(channel, seed, recoveryID, TextGroupedRotationProjectionVersion, 0)
	if err != nil || current.recipient == nil || current.rotation == nil || current.rotation.LiveProfiles == "" {
		t.Fatalf("v13 access proof omitted grouped commitment: %v", err)
	}
	for version := TextRotationAudienceVersion; version < TextGroupedRotationProjectionVersion; version++ {
		legacy, err := state.textRecipientCommitment(channel, seed, recoveryID, version, 0)
		if err != nil || legacy.rotation == nil || legacy.rotation.Live != current.rotation.Live ||
			legacy.rotation.Archive != current.rotation.Archive || legacy.rotation.LiveProfiles != "" ||
			legacy.root != "adcb65aa0c04a82258770d15042d0d06588f2831490b35cf2b8d2ba40530ba82" {
			t.Fatalf("v%d rotation audience changed: %+v, %v", version, legacy.rotation, err)
		}
		encoded, err := json.Marshal(legacy.rotation)
		if err != nil || strings.Contains(string(encoded), "liveProfiles") {
			t.Fatalf("v%d disclosed grouped audience: %s, %v", version, encoded, err)
		}
	}
	profiles, err := textRotationProfilesDigest(state.KeyRecipients, seed, channel, LiveEpoch)
	if err != nil || profiles != current.rotation.LiveProfiles {
		t.Fatalf("v13 omitted an eligible live recipient from grouped commitment: %s, %v", profiles, err)
	}
	remaining := maps.Clone(state.KeyRecipients)
	delete(remaining, recoveryID)
	withoutRecovery, err := textRotationProfilesDigest(remaining, seed, channel, LiveEpoch)
	if err != nil || withoutRecovery == profiles {
		t.Fatal("dropping one recovery recipient did not change the grouped digest")
	}
	for id, recipient := range remaining {
		if recipient.ProfileID == owner {
			delete(remaining, id)
		}
	}
	withoutOwner, err := textRotationProfilesDigest(remaining, seed, channel, LiveEpoch)
	if err != nil || withoutOwner == profiles || withoutOwner == withoutRecovery {
		t.Fatal("dropping an entire profile did not change the grouped digest")
	}
	empty, err := textRotationProfilesDigest(nil, seed, channel, LiveEpoch)
	if err != nil {
		t.Fatal(err)
	}
	newRoot, err := state.textProjectionRoot(strings.Repeat("aa", 32), TextGroupedRotationProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	oldRoot, err := state.textProjectionRoot(strings.Repeat("aa", 32), ProfileACLBypassProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	archiveV14, err := state.textRecipientCommitment(channel, seed, recoveryID, TextGroupedArchiveRotationProjectionVersion, 0)
	if err != nil || archiveV14.rotation == nil || archiveV14.rotation.Live != current.rotation.Live ||
		archiveV14.rotation.Archive != current.rotation.Archive || archiveV14.rotation.LiveProfiles != current.rotation.LiveProfiles {
		t.Fatalf("v14 changed earlier rotation digests: %+v, %v", archiveV14.rotation, err)
	}
	raw, err := json.Marshal(current.rotation)
	if err != nil || strings.Contains(string(raw), "archiveProfiles") {
		t.Fatalf("v13 carried an archive profile root: %s, %v", raw, err)
	}
	archiveEmpty, err := textRotationProfilesDigest(nil, seed, channel, ArchiveEpoch)
	if err != nil {
		t.Fatal(err)
	}
	archiveRoot, err := state.textProjectionRoot(strings.Repeat("aa", 32), TextGroupedArchiveRotationProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	archiveOpening := textRotationProfileOpening(seed, channel, ArchiveEpoch, owner)
	revisionV15, err := state.textRecipientCommitment(channel, seed, recoveryID, TextGroupedRevisionAudienceProjectionVersion, 4)
	if err != nil || revisionV15.rotation == nil || revisionV15.rotation.Live != archiveV14.rotation.Live ||
		revisionV15.rotation.Archive != archiveV14.rotation.Archive || revisionV15.rotation.LiveProfiles != archiveV14.rotation.LiveProfiles ||
		revisionV15.rotation.ArchiveProfiles != archiveV14.rotation.ArchiveProfiles {
		t.Fatalf("v15 changed a previous rotation digest: %+v, %v", revisionV15.rotation, err)
	}
	revisionRoot, err := state.textProjectionRoot(strings.Repeat("aa", 32), TextGroupedRevisionAudienceProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	for _, vector := range []struct{ label, got, want string }{
		{"empty grouped root", empty, "9c191112387bebf09c2112bdc3a9945a664c14dd99424defe9425f14fd0c3489"},
		{"v13 grouped root", profiles, "7d7440d1d39185b8877177b0e78d833d0120aace40d4a5af7e6119596f095bd2"},
		{"existing live digest", current.rotation.Live, "7ff3787fadc69866881c7616c75cfdb60fdbf4d4f36382f0afe60d603732f8d4"},
		{"existing archive digest", current.rotation.Archive, "c6e4c23fb174a0246b3dd6a3f951b9842f0b133d96497fa0a1dc33bfb010e9fa"},
		{"v13 channel digest", current.root, "6b802a00e563600baaabb02df00e8d2e90fc2a883d20d58ef3f514bf920ee4a1"},
		{"v12 policy root", oldRoot, "3b9d784a07e13daedad3970a6d4b5261c41d62b26f85197443a5ec797430a62f"},
		{"v13 policy root", newRoot, "612390f085de73981935cadfbb6b292eaf8d6beb560834bd78c818e9fe1d688f"},
		{"without recovery device", withoutRecovery, "dea4da644c1b311e1380f65212fc6524414866c2b088fb9507e115a46426f73b"},
		{"without owner profile", withoutOwner, "e8bf78219fee80deac2791d275ece94d1135d1aad3576fca0e89e9379705892b"},
		{"archive profile salt", archiveOpening.Salt, "a05aba4ccf49f8b0fb446da0de0633b8cab88122925b8eeee0eb529fc3f095a7"},
		{"archive content salt", archiveOpening.ContentSalt, "4261ac4db66af8c07fe5f616d53b9978b6be2e71a9d147d09ea2d6c55f767bb8"},
		{"empty archive grouped root", archiveEmpty, "d48230b64811a2a16ccab380faf07e9b20e65cb0ef16a4bfeb8ea64b3a25622c"},
		{"v14 archive grouped root", archiveV14.rotation.ArchiveProfiles, "aa9bdc259b0cb248ffdcffc229b9cdc82757a4771b331ac5403250a267414ca8"},
		{"v14 channel digest", archiveV14.root, "f09bf379357bca5a49464c4f139e5b5cb6448793558ec0a8c7d2e03c652c668b"},
		{"v14 policy root", archiveRoot, "67120f0c109f4d83fa34f60134cd2de084031fc53016dfa6efed93d7df338060"},
		{"v15 limited profile root", revisionV15.rotation.LimitedProfiles, "94ba52a7504f2c9e0fba6ee38aa8ac246f7267fbbf39033ebffae07b63e532ea"},
		{"v15 channel digest", revisionV15.root, "d495da7b52aa73ede18a6ee6b50bf287da43800e49d43c0b4c1fef50ecc15cf0"},
		{"v15 policy root", revisionRoot, "49d21487e9592a70f764484744439b966d0974a5d5b28e7c0769150589c5a581"},
	} {
		if vector.got != vector.want {
			t.Errorf("%s = %s, want %s", vector.label, vector.got, vector.want)
		}
	}
}

func TestScopedLiveRotationV13OnlyOpensCurrentProfiles(t *testing.T) {
	for _, version := range []int{ProfileACLBypassProjectionVersion, TextGroupedRotationProjectionVersion, TextGroupedArchiveRotationProjectionVersion} {
		t.Run(strconv.Itoa(version), func(t *testing.T) {
			ctx := context.Background()
			_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "grouped-live.sqlite")))
			now := time.Now()
			store.now = func() time.Time { return now }
			channel, owner, reader := strings.Repeat("9", 32), strings.Repeat("1", 64), strings.Repeat("2", 64)
			state := State{
				RoleSnapshot: RoleSnapshot{
					Policy: Policy{Owner: owner, Roles: map[string]Role{Everyone: {Grants: []string{ChannelView}}}},
					Members: map[string]Subject{
						owner: {ID: owner, Active: true}, reader: {ID: reader, Active: true},
					},
				},
				Channels:      map[string]Channel{channel: {Kind: "text", NextPosition: 1}},
				PolicyDevices: make(map[string]PolicyDevice),
				KeyRecipients: make(map[string]KeyRecipient),
			}
			devices := make(map[string]string)
			for _, fixture := range []struct {
				profile string
				seed    byte
			}{{owner, 1}, {reader, 2}} {
				key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(fixture.seed))
				device := hexHash(parseScopeAuthorityKey(key))
				state.PolicyDevices[device] = PolicyDevice{ProfileID: fixture.profile, PublicKey: key}
				state.KeyRecipients[device] = KeyRecipient{ProfileID: fixture.profile, Kind: "device",
					PublicKey: recoveryTestAgreementKey(t, fixture.seed)}
				devices[fixture.profile] = device
			}
			recovery := RecoveryIdentity{ID: strings.Repeat("f", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(3)),
				AgreementKey: recoveryTestAgreementKey(t, 3)}
			state.RecoveryIdentities = map[string]RecoveryIdentity{owner: recovery}
			state.KeyRecipients[recovery.ID] = KeyRecipient{ProfileID: owner, Kind: "recovery", PublicKey: recovery.AgreementKey}
			if err := store.Initialize(ctx, state); err != nil {
				t.Fatal(err)
			}
			resolve := func(context.Context, SessionQuery) (Principal, error) {
				return Principal{ProfileID: owner, DeviceID: devices[owner]}, nil
			}
			commit := func(draft PolicyDraft, signatureByte byte) {
				t.Helper()
				draft, err := store.PreviewPolicy(ctx, resolve, draft)
				if err != nil {
					t.Fatal(err)
				}
				draft.Signature = make([]byte, 64)
				draft.Signature[0] = signatureByte
				if _, err := store.CommitPolicy(ctx, resolve, func(context.Context, SessionQuery, Principal, PolicyDraft) error {
					return nil
				}, draft); err != nil {
					t.Fatal(err)
				}
			}
			commit(PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32),
				TextProjectionVersion: version, TextProjectionSeed: strings.Repeat("aa", 32)}, 1)
			now = now.Add(time.Duration(rotationPriorityMillis) * time.Millisecond)
			var cache TextChannelPolicyProofCache
			resolveReader := func(context.Context, SessionQuery) (Principal, error) {
				return Principal{ProfileID: reader, DeviceID: devices[reader]}, nil
			}
			if err := store.DispatchTransitionRotationTask(ctx, resolveReader, channel, LiveEpoch, &cache, false, func(RotationTask) error {
				t.Fatal("initial rotation has no prior transition proof")
				return nil
			}); !errors.Is(err, ErrPolicyAttestationUnavailable) {
				t.Fatalf("unverifiable rotation claim returned %v", err)
			}
			claim := func(purpose string, scope *TextChannelPolicyProofCache) RotationTask {
				t.Helper()
				var task RotationTask
				if err := store.DispatchRotationTask(ctx, resolve, channel, purpose, scope, func(value RotationTask) error {
					task = value
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				return task
			}
			before := claim(LiveEpoch, &cache)
			if len(before.Recipients) != 3 || before.TextPolicy == nil || before.TextPolicy.Rotation == nil {
				t.Fatalf("invalid scoped rotation claim: %+v", before)
			}
			if version < TextGroupedRotationProjectionVersion {
				if before.RotationProfileOpenings != nil || before.TextPolicy.Rotation.LiveProfiles != "" {
					t.Fatalf("old claim exposed grouped openings: %+v", before)
				}
				return
			}
			var beforeSeed [32]byte
			if _, err := hex.Decode(beforeSeed[:], []byte(strings.Repeat("aa", 32))); err != nil {
				t.Fatal(err)
			}
			if len(before.RotationProfileOpenings) != 2 ||
				before.RotationProfileOpenings[owner] != textRotationProfileOpening(beforeSeed, channel, LiveEpoch, owner) ||
				before.RotationProfileOpenings[reader] != textRotationProfileOpening(beforeSeed, channel, LiveEpoch, reader) {
				t.Fatalf("openings do not correspond to the claimed roster: %+v", before.RotationProfileOpenings)
			}
			if unscoped := claim(LiveEpoch, nil); unscoped.RotationProfileOpenings != nil {
				t.Fatalf("unscoped rotation exposed profile salts: %+v", unscoped)
			}
			record := before.EpochRecord
			record.KeyID, record.Signature = strings.Repeat("b", 64), make([]byte, 64)
			var packages []EpochPackage
			for id := range before.Recipients {
				packet := make([]byte, EpochPackageSize)
				if id == recovery.ID {
					packet = make([]byte, RecoveryEpochPackageSize)
					copy(packet[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], scopeAuthorityTestKey(4).Public().(ed25519.PublicKey))
				}
				packages = append(packages, EpochPackage{RecipientID: id, Purpose: LiveEpoch, Ciphertext: packet})
			}
			var err error
			record.PackagesDigest, err = PackagesDigest(packages)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.CommitEpoch(ctx, resolve, func(context.Context, SessionQuery, Principal, EpochRecord) error {
				return nil
			}, record, packages, nil); err != nil {
				t.Fatal(err)
			}
			archive := claim(ArchiveEpoch, &cache)
			if version < TextGroupedArchiveRotationProjectionVersion {
				if archive.RotationProfileOpenings != nil || archive.TextPolicy.Rotation.ArchiveProfiles != "" {
					t.Fatalf("old archive rotation exposed group data: %+v", archive)
				}
			} else {
				want := textRotationProfileOpening(beforeSeed, channel, ArchiveEpoch, owner)
				root, err := textRotationProfilesDigest(archive.Recipients, beforeSeed, channel, ArchiveEpoch)
				if err != nil || root != archive.TextPolicy.Rotation.ArchiveProfiles ||
					len(archive.Recipients) != 2 || archive.Recipients[recovery.ID].Kind != "recovery" ||
					len(archive.RotationProfileOpenings) != 1 || archive.RotationProfileOpenings[owner] != want ||
					want.Salt == before.RotationProfileOpenings[owner].Salt || want.ContentSalt == before.RotationProfileOpenings[owner].ContentSalt {
					t.Fatalf("archive rotation did not segregate archive viewers and salts: %+v, %v", archive, err)
				}
				if unscoped := claim(ArchiveEpoch, nil); unscoped.RotationProfileOpenings != nil {
					t.Fatalf("unscoped archive rotation exposed salts: %+v", unscoped)
				}
				limited := func(context.Context, SessionQuery) (Principal, error) {
					return Principal{ProfileID: reader, DeviceID: devices[reader]}, nil
				}
				err = store.DispatchRotationTask(ctx, limited, channel, ArchiveEpoch, &cache, func(RotationTask) error {
					t.Fatal("limited-history reader received archive rotation")
					return nil
				})
				if !errors.Is(err, ErrRotationUnavailable) {
					t.Fatalf("limited-history archive claim = %v", err)
				}
			}
			commit(PolicyDraft{Action: UpdateChannelACL, OperationID: strings.Repeat("2", 32),
				TextProjectionVersion: version, TextProjectionSeed: strings.Repeat("bb", 32),
				ResourceChange: &PolicyResourceChange{ID: channel, ACL: &ACL{
					Profiles: map[string]Overwrite{reader: {Deny: []string{ChannelView}}},
				}}}, 2)
			after := claim(LiveEpoch, &cache)
			if len(after.Recipients) != 2 || len(after.RotationProfileOpenings) != 1 ||
				after.RotationProfileOpenings[owner].Salt == before.RotationProfileOpenings[owner].Salt {
				t.Fatalf("current claim did not refresh the remaining profile opening: %+v", after)
			}
			if raw, err := json.Marshal(after.RotationProfileOpenings); err != nil || strings.Contains(string(raw), reader) {
				t.Fatalf("revoked profile received an opening in a current claim: %s, %v", raw, err)
			}
		})
	}
}
