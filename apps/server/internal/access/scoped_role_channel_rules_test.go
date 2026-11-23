package access

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"os/exec"
	"strings"
	"testing"
)

func TestScopedRoleChannelRuleOpenings(t *testing.T) {
	owner, mixed, overridden, inherited, hidden := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64),
		strings.Repeat("4", 64), strings.Repeat("5", 64)
	text, voice := strings.Repeat("a", 32), strings.Repeat("b", 32)
	rosterChannel := strings.Repeat("c", 32)
	assigner := strings.Repeat("6", 64)
	signingKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	publicKey := signingKey.Public().(ed25519.PublicKey)
	assignerDevice := hexHash(publicKey)
	targetSigningKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{20}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	targetDevice := hexHash(targetSigningKey)
	limitedProfile := strings.Repeat("7", 64)
	limitedSigningKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{23}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	limitedDevice := hexHash(limitedSigningKey)
	revokedProfile := strings.Repeat("9", 64)
	revokedSigningKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{21}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	revokedDevice := hexHash(revokedSigningKey)
	ownerSigningKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{22}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	ownerDevice := hexHash(ownerSigningKey)
	agreementKey := func(seed byte) string {
		t.Helper()
		key, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{seed}, 32))
		if err != nil {
			t.Fatal(err)
		}
		return hex.EncodeToString(key.PublicKey().Bytes())
	}
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"allow", "deny", "live-only", "delegate"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView, "history.full", "voice.connect", "voice.speak"}}, "allow": {Grants: []string{"message.send"}}, "deny": {},
				"live-only": {Grants: []string{"message.send"}}, "delegate": {Grants: []string{"role.assign", "member.list"}},
			}},
			Members: map[string]Subject{
				owner: {ID: owner, Active: true}, mixed: {ID: mixed, Active: true, Roles: []string{"allow", "deny"}},
				overridden: {ID: overridden, Active: true, Roles: []string{"deny"}}, inherited: {ID: inherited, Active: true},
				hidden:         {ID: hidden, Active: true},
				assigner:       {ID: assigner, Active: true, Roles: []string{"allow", "delegate"}},
				revokedProfile: {ID: revokedProfile, Active: true, Roles: []string{"allow"}},
				limitedProfile: {ID: limitedProfile, Active: true, Roles: []string{"live-only"}},
			},
		},
		Channels: map[string]Channel{
			text:  {Kind: "text", CategoryID: "category", Synchronized: true, NextPosition: 1},
			voice: {Kind: "voice", ACL: ACL{Profiles: map[string]Overwrite{mixed: {Deny: []string{"voice.connect"}}}}},
			rosterChannel: {Kind: "text", NextPosition: 1, ACL: ACL{Profiles: map[string]Overwrite{
				limitedProfile: {Deny: []string{ChannelView}},
			}}},
		},
		Categories: map[string]ACL{"category": {
			Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView, "history.full"}},
				"allow": {Allow: []string{ChannelView, "history.full"}}, "deny": {Deny: []string{ChannelView, "history.full"}},
				"live-only": {Allow: []string{ChannelView}}},
			Profiles: map[string]Overwrite{mixed: {Deny: []string{"history.full"}},
				overridden: {Allow: []string{ChannelView, "history.full"}}, hidden: {Deny: []string{ChannelView}}},
		}},
		PolicyDevices: map[string]PolicyDevice{assignerDevice: {ProfileID: assigner, PublicKey: hex.EncodeToString(publicKey)},
			targetDevice:  {ProfileID: inherited, PublicKey: hex.EncodeToString(targetSigningKey)},
			revokedDevice: {ProfileID: revokedProfile, PublicKey: hex.EncodeToString(revokedSigningKey)},
			limitedDevice: {ProfileID: limitedProfile, PublicKey: hex.EncodeToString(limitedSigningKey)},
			ownerDevice:   {ProfileID: owner, PublicKey: hex.EncodeToString(ownerSigningKey)}},
		KeyRecipients: map[string]KeyRecipient{
			targetDevice:   {ProfileID: inherited, Kind: "device", PublicKey: agreementKey(20)},
			assignerDevice: {ProfileID: assigner, Kind: "device", PublicKey: agreementKey(19)},
			revokedDevice:  {ProfileID: revokedProfile, Kind: "device", PublicKey: agreementKey(21)},
			ownerDevice:    {ProfileID: owner, Kind: "device", PublicKey: agreementKey(22)},
			limitedDevice:  {ProfileID: limitedProfile, Kind: "device", PublicKey: agreementKey(23)},
		},
	}
	for index := range 64 {
		profile := fmt.Sprintf("%064x", index+100)
		state.Members[profile] = Subject{ID: profile, Active: true}
		state.Categories["category"].Profiles[profile] = Overwrite{Deny: []string{"history.full"}}
	}
	state.refreshAdmissions()
	channel := state.Channels[text]
	channel.NextPosition = 11
	state.Channels[text] = channel
	var seed [32]byte
	for index := range seed {
		seed[index] = 0x99
	}
	seedHex := hex.EncodeToString(seed[:])
	const version = ProfileRoleAuthorityProjectionVersion
	policy, err := state.textProjectionTree(seedHex, version)
	if err != nil {
		t.Fatal(err)
	}
	if !HasTextRecipientProjection(version) {
		t.Fatal("role authority projection is unavailable")
	}
	invites, err := policy.inviteAdmission.digest()
	if err != nil {
		t.Fatal(err)
	}
	rankPath, err := policy.proof(profileRankProjectionID)
	if err != nil {
		t.Fatal(err)
	}
	keys := scopedRoleKeys(state)
	cases := make([]map[string]any, 0)
	for _, id := range []string{text, voice} {
		resource := state.Channels[id]
		scope := state.scope(resource)
		basis, rules, err := state.scopedChannelRuleBasis(id, seed, policy)
		if err != nil {
			t.Fatal(err)
		}
		open := func(kind, id string) ScopedChannelRuleOpening {
			t.Helper()
			result, err := rules.opening(kind, id)
			if err != nil {
				t.Fatal(err)
			}
			return result
		}
		for _, profile := range []string{owner, mixed, overridden, inherited} {
			subject := state.Members[profile]
			roles := map[string]ScopedChannelRuleOpening{Everyone: open("role", Everyone)}
			for _, role := range subject.Roles {
				roles[role] = open("role", role)
			}
			personal := open("profile", profile)
			if profile == inherited && (personal.Mask != 0 || personal.Salt != "" || id == text && len(personal.Path) == 0) {
				t.Fatalf("inherited rule was not independently provable: %+v", personal)
			}
			proof, err := policy.ranks.proof(profile)
			if err != nil {
				t.Fatal(err)
			}
			expected := map[string]bool{"view": state.CheckGrant(subject, scope, ChannelView, 0) == Allowed,
				"fullHistory": state.CheckGrant(subject, scope, "history.full", 0) == Allowed,
				"connect":     state.CheckGrant(subject, scope, "voice.connect", 0) == Allowed,
				"speak":       state.CheckGrant(subject, scope, "voice.speak", 0) == Allowed,
				"canSend":     state.CheckGrant(subject, scope, "message.send", 0) == Allowed}
			cases = append(cases, map[string]any{"channel": id, "kind": resource.Kind, "profile": profile, "basis": basis, "expected": expected,
				"proof": proof, "opening": state.profileRoleAuthority(seed, subject, keys[profile]),
				"evidence": map[string]any{"roles": roles, "personal": personal}})
		}
	}
	proofs, err := json.Marshal(cases)
	if err != nil || bytes.Contains(proofs, []byte(hidden)) {
		t.Fatalf("scoped proof exposed another profile: %v", err)
	}
	const previousRevision = 7
	previousHead, serverID, cutover := strings.Repeat("2", 64), strings.Repeat("3", 32), strings.Repeat("4", 64)
	actor := Principal{ProfileID: assigner, DeviceID: assignerDevice}
	policyDigest := strings.Repeat("9", 64)
	signedAssignment := func(target, operation, roster string, add, remove []string) PolicyDraft {
		t.Helper()
		edit := ScopedRoleEdit{Change: ScopedRoleChange{Revision: previousRevision, PolicyHead: previousHead,
			TargetProfile: target, RosterChannel: roster, Add: add, Remove: remove}, CutoverDigest: cutover, ServerKey: "synthetic"}
		if roster != "" {
			edit.Change.RosterCommitment, _ = scopedRoleRosterAlias(seed, roster)
		}
		frame, err := ScopedRoleEditFrame(serverID, actor, operation, edit)
		if err != nil {
			t.Fatal(err)
		}
		edit.EditorProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(signingKey, frame))
		return PolicyDraft{Action: EditScopedRoles, OperationID: operation, Revision: previousRevision + 1, PreviousDigest: previousHead,
			ResultDigest: policyDigest, ResourceChange: &PolicyResourceChange{RolesEdit: &edit}}
	}
	draft := signedAssignment(inherited, strings.Repeat("5", 32), rosterChannel, []string{"allow"}, nil)
	previousPolicyDigest := strings.Repeat("f", 64)
	predecessor := PolicyProof{Digest: previousHead, Draft: PolicyDraft{Revision: previousRevision, ResultDigest: previousPolicyDigest,
		TextProjectionSeed: seedHex, TextProjectionRoot: policy.root(), TextProjectionVersion: version}}
	committedRoster := draft.ResourceChange.RolesEdit.Change
	if err := validateScopedRoleRosterCommitment(predecessor, committedRoster); err != nil {
		t.Fatal(err)
	}
	committedRoster.RosterChannel = text
	if err := validateScopedRoleRosterCommitment(predecessor, committedRoster); err == nil {
		t.Fatal("full replay accepted a substituted discovery channel with the original alias")
	}
	revocationDraft := signedAssignment(revokedProfile, strings.Repeat("6", 32), "", nil, []string{"allow"})
	historyDraft := signedAssignment(revokedProfile, strings.Repeat("7", 32), "", []string{"live-only"}, []string{"allow"})
	historyGrant := signedAssignment(limitedProfile, strings.Repeat("8", 32), "", []string{"allow"}, []string{"live-only"})
	transition := map[string]any{"trust": map[string]string{"serverId": serverID, "cutoverDigest": cutover},
		"expectedKey": targetDevice, "channelId": text}
	rotations := make([]map[string]any, 0, 6)
	var history textChannelPolicyTreeCache
	orderProof, err := orderAuthorityDisclosure(state, predecessor, text, ownerDevice, &history)
	if err != nil {
		t.Fatal(err)
	}
	settingsProof, err := channelSettingsDisclosure(state, predecessor, text, &history)
	if err != nil {
		t.Fatal(err)
	}
	aclProof, _, err := channelACLDisclosure(state, predecessor, text, ownerDevice, &history)
	if err != nil {
		t.Fatal(err)
	}
	aclRankProof, err := channelACLRankBasis(state, predecessor, owner, inherited, &history)
	if err != nil {
		t.Fatal(err)
	}
	roster := []VoiceKeyRecipient{{SessionID: strings.Repeat("8", 32), ProfileID: owner, DeviceID: ownerDevice,
		PublicKey: state.KeyRecipients[ownerDevice].PublicKey}}
	voiceProof, err := voiceChannelPolicyDisclosure(state, predecessor, voice, roster, &history)
	if err != nil {
		t.Fatal(err)
	}
	inviteProof, err := state.inviteAdmissionScopeOpening(seed, version)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []PolicyDraft{draft, revocationDraft, historyDraft, historyGrant} {
		current := state
		change := scenario.ResourceChange.RolesEdit.Change
		update, err := state.scopedRoleUpdate(actor, change)
		if err != nil {
			t.Fatal(err)
		}
		if err := current.applyRoles(actor.ProfileID, update); err != nil {
			t.Fatal(err)
		}
		current.refreshAdmissions()
		scenario.TextProjectionSeed, scenario.TextProjectionVersion = strings.Repeat("a7", 32), version
		scenario.TextProjectionRoot, err = current.textProjectionRoot(scenario.TextProjectionSeed, version)
		if err != nil {
			t.Fatal(err)
		}
		scenario.ResultDigest, err = current.PolicyDigest()
		if err != nil {
			t.Fatal(err)
		}
		for _, purpose := range []string{LiveEpoch, ArchiveEpoch} {
			recipients, err := current.rotationRecipients(text, purpose)
			if err != nil {
				t.Fatal(err)
			}
			if (scenario.OperationID == historyDraft.OperationID || scenario.OperationID == historyGrant.OperationID) && purpose == LiveEpoch {
				before, err := state.rotationRecipients(text, purpose)
				if err != nil || !maps.Equal(before, recipients) {
					t.Fatalf("history-only change altered live recipients: %v", err)
				}
				priorAdmission := state.Admissions[text][change.TargetProfile]
				if priorAdmission.FirstPosition != 1 || current.Admissions[text][change.TargetProfile] != priorAdmission {
					t.Fatal("history-only change reset continuous admission")
				}
				continue
			}
			task := RotationTask{EpochRecord: EpochRecord{Purpose: purpose, ChannelID: text, Revision: previousRevision + 1,
				PolicyDigest: scenario.ResultDigest}, Recipients: recipients}
			head := PolicyProof{Principal: actor, Draft: scenario, Digest: strings.Repeat("a", 64)}
			evidence, err := buildScopedRoleAssignmentRotationEvidence(state, current, predecessor, head, task, actor, &history)
			if err != nil || evidence == nil {
				t.Fatalf("%s %s rotation evidence: %v", change.TargetProfile, purpose, err)
			}
			if change.RosterChannel != "" {
				_, salt := scopedRoleRosterAlias(seed, rosterChannel)
				encoded, err := json.Marshal(evidence)
				if err != nil || evidence.Assignment.Roster == nil || bytes.Contains(encoded, []byte(rosterChannel)) ||
					bytes.Contains(encoded, []byte(salt)) || state.CanDeliver(limitedProfile, rosterChannel, 0) {
					t.Fatalf("assignment proof exposed its discovery channel: %v", err)
				}
			}
			outside := *head.Draft.ResourceChange.RolesEdit
			outside.Change.RosterChannel = strings.Repeat("f", 32)
			otherChannel := head
			otherChannel.Draft.ResourceChange = &PolicyResourceChange{RolesEdit: &outside}
			if result, err := buildScopedRoleAssignmentRotationEvidence(state, current, predecessor, otherChannel, task, actor, &history); err != nil || result != nil {
				t.Fatalf("rotation evidence exposed a different roster channel: %v", err)
			}
			if change.TargetProfile == revokedProfile {
				opening := textRotationProfileOpening(seed, text, purpose, revokedProfile)
				encoded, err := json.Marshal(evidence)
				if err != nil || evidence.RemovedGroup == nil || bytes.Contains(encoded, []byte(revokedDevice)) || bytes.Contains(encoded, []byte(opening.ContentSalt)) {
					t.Fatalf("revocation included the removed group's keys or content salt: %v", err)
				}
				revoked := Principal{ProfileID: revokedProfile, DeviceID: revokedDevice}
				if result, err := buildScopedRoleAssignmentRotationEvidence(state, current, predecessor, head, task, revoked, &history); err != nil || result != nil {
					t.Fatalf("revoked claimant received a rotation witness: %v", err)
				}
			} else if purpose == LiveEpoch {
				transition["record"], transition["evidence"] = evidence.Record, evidence.Assignment
			}
			marker, err := scopedRoleAssignmentEpochDigest(task.EpochRecord, evidence.Record)
			if err != nil {
				t.Fatal(err)
			}
			task.RoleAssignment = evidence
			epoch := EpochProof{Principal: actor, Record: task.EpochRecord}
			if purpose == ArchiveEpoch {
				epoch.Record.ArchiveTransitionDigest = marker
			} else {
				epoch.Record.LiveTransitionDigest = marker
			}
			viewers := []Principal{actor, {ProfileID: owner, DeviceID: ownerDevice}}
			if change.TargetProfile == inherited {
				viewers = append(viewers, Principal{ProfileID: inherited, DeviceID: targetDevice})
				if purpose == LiveEpoch {
					viewers = append(viewers, Principal{ProfileID: limitedProfile, DeviceID: limitedDevice})
				}
			}
			if change.TargetProfile == limitedProfile {
				viewers = append(viewers, Principal{ProfileID: limitedProfile, DeviceID: limitedDevice})
			}
			var deliveries []map[string]any
			for _, viewer := range viewers {
				read, err := buildScopedRoleAssignmentReadEvidence(state, current, current, predecessor, head, epoch, viewer, &history)
				if err != nil || read == nil {
					t.Fatalf("%s %s delivery evidence: %v", viewer.ProfileID, purpose, err)
				}
				if viewer.ProfileID != change.TargetProfile && (read.SuccessorViewerPolicy != nil || read.Assignment.Target.Opening["keys"] != nil) {
					t.Fatal("delivery of an unchanged profile disclosed the affected profile's keys")
				}
				deliveries = append(deliveries, map[string]any{
					"delivery": EpochPackageDelivery{Epoch: epoch, Package: EpochPackage{RecipientID: viewer.DeviceID, Purpose: purpose}, RoleAssignment: read},
					"recipient": map[string]string{"recipientId": viewer.DeviceID, "profileId": viewer.ProfileID,
						"recipientKey": current.KeyRecipients[viewer.DeviceID].PublicKey, "purpose": purpose},
				})
			}
			if change.TargetProfile == revokedProfile {
				if result, err := buildScopedRoleAssignmentReadEvidence(state, current, current, predecessor, head, epoch,
					Principal{ProfileID: revokedProfile, DeviceID: revokedDevice}, &history); err != nil || result != nil {
					t.Fatalf("revoked recipient received delivery evidence: %v", err)
				}
			}
			fixture := map[string]any{"task": task, "marker": marker, "deliveries": deliveries}
			if scenario.OperationID == historyDraft.OperationID || scenario.OperationID == historyGrant.OperationID {
				viewer := Principal{ProfileID: revokedProfile, DeviceID: revokedDevice}
				if scenario.OperationID == historyGrant.OperationID {
					viewer = Principal{ProfileID: limitedProfile, DeviceID: limitedDevice}
				}
				live := EpochRecord{ChannelID: text, Purpose: LiveEpoch, Generation: 1, Revision: previousRevision, PolicyDigest: previousPolicyDigest}
				archive := epoch
				archive.Record.ArchiveThrough = 1
				historyProof, err := buildLiveRoleHistoryEvidence(state, current, predecessor, head, live, &archive, viewer, &history)
				if err != nil || historyProof == nil || historyProof.Transition.Assignment.Target.Opening["keys"] != nil {
					t.Fatalf("history-only proof for live viewer: %v", err)
				}
				currentView, err := textChannelDisclosure(current, head, text, viewer.DeviceID, &history, 0)
				if err != nil || currentView == nil {
					t.Fatalf("history-only current live disclosure: %v", err)
				}
				fixture["liveHistory"] = map[string]any{"proof": historyProof, "textPolicy": currentView,
					"recipient": state.KeyRecipients[viewer.DeviceID], "deviceId": viewer.DeviceID,
					"granted": scenario.OperationID == historyGrant.OperationID}
			}
			if change.TargetProfile == inherited && purpose == LiveEpoch {
				basis := liveMessageAuthorBasis{epoch: epoch.Record, previous: state, predecessor: predecessor, roleTarget: inherited}
				opening, err := basis.roleAssignmentAuthorKey(Principal{ProfileID: inherited, DeviceID: targetDevice})
				if err != nil || opening == nil {
					t.Fatalf("newly admitted author signing key proof: %v", err)
				}
				target := state.profileRoleAuthority(seed, state.Members[inherited], scopedRoleKeys(state)[inherited])
				encoded, err := json.Marshal(opening)
				if err != nil || bytes.Contains(encoded, []byte(target.KeysSalt)) ||
					bytes.Contains(encoded, []byte(state.KeyRecipients[targetDevice].PublicKey)) {
					t.Fatalf("author proof disclosed a recipient key or the profile salt: %v", err)
				}
				fixture["newAuthorKey"] = opening
			}
			rotations = append(rotations, fixture)
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for cross-language channel rule verification")
	}
	payload, err := json.Marshal(map[string]any{"state": state, "seed": seedHex, "cases": cases, "rankRoot": policy.ranks.digest,
		"invites": invites, "catalogue": policy.roleCatalogue.digest(), "rosters": policy.roleRosters.commitment.digest, "rankPath": rankPath,
		"attestation": map[string]any{"root": policy.root(), "projectionVersion": version, "revision": previousRevision,
			"digest": previousHead, "policyDigest": previousPolicyDigest},
		"transition": transition, "rotations": rotations, "publisher": map[string]string{"deviceId": assignerDevice, "profileId": assigner},
		"unrelatedDevice": ownerDevice, "readerWithoutRoster": limitedDevice,
		"compatibility": map[string]any{"order": orderProof, "settings": settingsProof, "acl": aclProof, "aclRank": aclRankProof,
			"voice": voiceProof, "voiceChannel": voice, "voiceRoster": roster, "invite": inviteProof, "previousDraft": predecessor.Draft}})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, "-e", `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash, createPrivateKey, sign } = require('node:crypto');
const base = '../../../client/windows/electron/';
const { verifyScopedChannelKeyAccess } = require(base + 'protected-role-channel-rules.cjs');
const { verifyAttestedProfileRoleAuthority, verifyPersonalACLTargetRank } = require(base + 'protected-policy-profile-ranks.cjs');
const { channelPolicyRoot, verifyChannelOrderAuthority, verifyChannelSettings, verifyChannelACLAuthority } = require(base + 'protected-channel-policy-commitments.cjs');
const { channelPolicyProjectionDigests } = require(base + 'protected-policy-replay.cjs');
const { verifyInviteAdmissionProjection } = require(base + 'protected-invite-admission-commitment.cjs');
const { verifyPolicyTextProjection } = require(base + 'protected-policy-checkpoint.cjs');
const { verifyAttestedVoiceRoster, policyAttestationFrame, verifyPolicyAttestation } = require(base + 'protected-policy-attestation.cjs');
const { voiceRosterDigest } = require(base + 'protected-voice-keys.cjs');
const { verifyScopedRoleAssignment, verifyRoleAssignmentRotation, verifyRoleAssignmentDelivery,
  verifyRoleAssignmentAuthor } = require(base + 'protected-role-assignment-transition.cjs');
const { epochSignatureFrame, verifySignedEpoch } = require(base + 'protected-epoch-packages.cjs');
const { MembershipClient } = require(base + 'membership-client.cjs');
const { deviceAgreementKeySlot } = require(base + 'protected-device-agreement.cjs');
const { runLiveRotation, runArchiveRotation } = require(base + 'protected-archive-session.cjs');
const { sealProtectedText } = require(base + 'protected-live-text.cjs');
const { state, seed, cases, rankRoot, invites, catalogue, rosters, rankPath, attestation, transition, rotations,
  publisher, unrelatedDevice, readerWithoutRoster, compatibility } = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.equal(channelPolicyRoot(channelPolicyProjectionDigests(state, seed, attestation.projectionVersion), seed), attestation.root);
verifyPolicyTextProjection(compatibility.previousDraft, state);
const owner = compatibility.order.actor;
const trust = { ...transition.trust, anchorDigest: '1'.repeat(64), ownerProfileId: owner.ProfileID, ownerDeviceId: owner.DeviceID };
const view = { ...attestation, previous: '8'.repeat(64), signerKey: state.PolicyDevices[owner.DeviceID].PublicKey };
view.signature = sign(null, policyAttestationFrame(trust, view), createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 22)]), type: 'pkcs8', format: 'der',
})).toString('base64');
const signed = verifyPolicyAttestation(trust, view);
const voiceBasis = { channelId: compatibility.voiceChannel, revision: signed.revision, policyDigest: signed.policyDigest,
  rosterDigest: voiceRosterDigest(compatibility.voiceRoster) };
const checks = [
  [compatibility.order, proof => verifyChannelOrderAuthority(signed, transition.channelId, proof, owner)],
  [compatibility.settings, proof => verifyChannelSettings(signed, transition.channelId, proof)],
  [compatibility.acl, proof => verifyChannelACLAuthority(signed, transition.channelId, proof, owner)],
  [compatibility.voice, proof => verifyAttestedVoiceRoster(signed, voiceBasis, compatibility.voiceRoster, proof)],
];
for (const [proof, verify] of checks) {
  assert.match(proof.roleRulesDigest, /^[a-f0-9]{64}$/);
  verify(proof);
  assert.throws(() => verify({ ...proof, roleRulesDigest: '0'.repeat(64) }));
  assert.throws(() => verify({ ...proof, roleRulesDigest: undefined }));
}
verifyInviteAdmissionProjection(signed, compatibility.invite);
assert.throws(() => verifyInviteAdmissionProjection(signed, { ...compatibility.invite, rosters: undefined }));
const verifyRank = proof => verifyPersonalACLTargetRank(signed, proof, owner.ProfileID, proof.target.profileId);
assert.equal(verifyRank(compatibility.aclRank), false);
assert.throws(() => verifyRank({ ...compatibility.aclRank, catalogue: '0'.repeat(64) }));
for (const item of cases) {
  const profile = verifyAttestedProfileRoleAuthority(attestation,
    { root: rankRoot, invites, catalogue, rosters, inclusion: rankPath, profile: item.proof }, item.profile, item.opening);
  const read = (evidence = item.evidence, basis = item.basis, channel = item.channel, kind = item.kind) =>
    verifyScopedChannelKeyAccess(attestation, channel, kind, item.profile, profile, basis, evidence);
  assert.deepEqual(read(), item.expected);
  const changed = structuredClone(item.evidence);
  changed.personal.mask = (changed.personal.mask + 1) % 243;
  assert.throws(() => read(changed));
  assert.throws(() => read(item.evidence, { ...item.basis, rulesDigest: '0'.repeat(64) }));
  assert.throws(() => read(item.evidence, item.basis, item.channel === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32)));
  assert.throws(() => read(item.evidence, item.basis, item.channel, item.kind === 'text' ? 'voice' : 'text'));
  if (item.evidence.personal.path.length) {
    const removed = structuredClone(item.evidence);
    removed.personal.path.pop();
    assert.throws(() => read(removed));
  }
  if (profile.roles.length) {
    const omitted = structuredClone(item.evidence);
    delete omitted.roles[profile.roles[0]];
    assert.throws(() => read(omitted));
  }
}
const verifyAssignment = (record = transition.record, evidence = transition.evidence) =>
  verifyScopedRoleAssignment(transition.trust, attestation, record, evidence, transition.channelId, 'text');
const assignment = verifyAssignment();
assert.deepEqual(assignment.before, { live: [], archive: [] });
assert.deepEqual(assignment.after.live.map(key => key.id), [transition.expectedKey]);
assert.deepEqual(assignment.after.archive.map(key => key.id), [transition.expectedKey]);
assert.equal(transition.record.Draft.ResourceChange.RolesEdit.Change.rosterChannelId, undefined);
assert.match(transition.record.Draft.ResourceChange.RolesEdit.Change.rosterCommitment, /^[a-f0-9]{64}$/);
assert.throws(() => verifyAssignment(transition.record, { ...transition.evidence, roster: undefined }));
const movedRoster = structuredClone(transition.record);
movedRoster.Draft.ResourceChange.RolesEdit.Change.rosterCommitment = '0'.repeat(64);
assert.throws(() => verifyAssignment(movedRoster));
const swappedRoster = structuredClone(transition.evidence);
[swappedRoster.roster.actor, swappedRoster.roster.target] = [swappedRoster.roster.target, swappedRoster.roster.actor];
assert.throws(() => verifyAssignment(transition.record, swappedRoster));
assert.equal(transition.evidence.actor.opening.keys, undefined);
assert.equal(transition.evidence.actor.opening.keysSalt, undefined);
assert.throws(() => verifyAssignment(transition.record, {
  ...transition.evidence, actorKey: { ...transition.evidence.actorKey, salt: '0'.repeat(64) },
}));
const mismatched = structuredClone(transition.record);
mismatched.Draft.ResourceChange.RolesEdit.Change.add = ['deny'];
assert.throws(() => verifyAssignment(mismatched));
const catalogueMismatch = structuredClone(transition.evidence);
catalogueMismatch.definitions.allow.rank++;
assert.throws(() => verifyAssignment(transition.record, catalogueMismatch));
const wrongKey = structuredClone(transition.evidence);
wrongKey.target.opening.keys[0].publicKey = 'a'.repeat(64);
assert.throws(() => verifyAssignment(transition.record, wrongKey));
for (const { task, marker, deliveries, newAuthorKey } of rotations) {
  const evidence = task.roleAssignment, record = evidence.record;
  const verify = (candidate = task, proof = evidence) => verifyRoleAssignmentRotation(transition.trust, attestation, candidate, record, proof, publisher);
  const revoked = evidence.removedGroup !== undefined;
  const verified = verify();
  assert.equal(task.Purpose === 'live' ? verified.liveTransitionDigest : verified.archiveTransitionDigest, marker);
  assert.equal(verified.after[task.Purpose].length, revoked ? 0 : 1);
  if (newAuthorKey) {
    const remaining = deliveries.find(({ recipient }) => recipient.recipientId === readerWithoutRoster);
    const target = deliveries.find(({ recipient }) => recipient.recipientId === transition.expectedKey);
    const epoch = remaining.delivery.Epoch.Record;
    const { delta } = verifyRoleAssignmentDelivery(transition.trust, attestation, remaining.delivery, remaining.recipient);
    assert.equal(delta.after.live, undefined);
    const transitionContext = { predecessor: attestation, assignment: evidence.record, delta };
    const author = { ProfileID: target.recipient.profileId, DeviceID: target.recipient.recipientId };
    const policy = target.delivery.roleAssignment.successorViewerPolicy;
    const first = policy.recipient.statement.firstPosition;
    assert.equal(first, 11);
    const verifyAuthor = (proof, position = first, identity = author, authorPolicy = policy) =>
      verifyRoleAssignmentAuthor(transitionContext, epoch, identity, undefined, position, authorPolicy, proof);
    assert.deepEqual(verifyAuthor(newAuthorKey), { deviceId: author.DeviceID, profileId: author.ProfileID,
      key: newAuthorKey.publicKey });
    assert.throws(() => verifyAuthor(newAuthorKey, first - 1));
    assert.throws(() => verifyAuthor(undefined));
    assert.throws(() => verifyAuthor({ ...newAuthorKey, publicKey: '0'.repeat(64) }));
    assert.throws(() => verifyAuthor({ ...newAuthorKey, path: [] }));
    assert.throws(() => verifyAuthor(newAuthorKey, first, { ...author, DeviceID: unrelatedDevice }));
    const unrelatedPolicy = structuredClone(policy);
    unrelatedPolicy.recipient.statement.signingKey = '0'.repeat(64);
    assert.throws(() => verifyAuthor(newAuthorKey, first, author, unrelatedPolicy));
  }
  for (const { delivery, recipient } of deliveries) {
    const read = (sealed = delivery, expected = recipient) => verifyRoleAssignmentDelivery(transition.trust, attestation, sealed, expected);
    const opened = read();
    assert.equal(opened.signer.deviceId, publisher.deviceId);
    assert.equal(opened.admission.id, recipient.recipientId);
    if (task.Purpose === 'live') {
      const transition = { predecessor: attestation, assignment: delivery.roleAssignment.record, delta: opened.delta };
      const author = { DeviceID: publisher.deviceId, ProfileID: publisher.profileId };
      const disclosure = delivery.roleAssignment.previousSignerTextPolicy;
      assert.deepEqual(verifyRoleAssignmentAuthor(transition, delivery.Epoch.Record, author, disclosure, 1), opened.signer);
      assert.throws(() => verifyRoleAssignmentAuthor(transition, delivery.Epoch.Record, author, disclosure, 0));
      assert.throws(() => verifyRoleAssignmentAuthor(transition, delivery.Epoch.Record, { ...author, DeviceID: unrelatedDevice }, disclosure, 1));
    }
    const epoch = structuredClone(delivery.Epoch), record = epoch.Record, archive = record.Purpose === 'archive';
    Object.assign(record, { Generation: 2, TaskID: '1'.repeat(32), LeaseID: '2'.repeat(32), PreviousDigest: '3'.repeat(64),
      KeyID: '4'.repeat(64), PackagesDigest: '5'.repeat(64), ArchiveThrough: archive ? 1 : 0,
      ArchiveLinksDigest: archive ? '6'.repeat(64) : '', ...(archive && { ArchiveWrapKey: '7'.repeat(64) }) });
    const publisherKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 19)]),
      type: 'pkcs8', format: 'der' });
    record.Signature = sign(null, epochSignatureFrame(transition.trust.serverId, opened.signer.profileId, opened.signer.deviceId, record), publisherKey).toString('base64');
    const context = { serverId: transition.trust.serverId, channelId: record.ChannelID, purpose: record.Purpose,
      generation: record.Generation, revision: record.Revision, policyDigest: record.PolicyDigest,
      previousDigest: record.PreviousDigest, taskId: record.TaskID, leaseId: record.LeaseID, keyId: record.KeyID };
    assert.match(verifySignedEpoch(epoch, context, opened.signer), /^[a-f0-9]{64}$/);
    record[archive ? 'ArchiveTransitionDigest' : 'LiveTransitionDigest'] = 'f'.repeat(64);
    assert.throws(() => verifySignedEpoch(epoch, context, opened.signer));
    assert.throws(() => read(delivery, { ...recipient, recipientKey: '0'.repeat(64) }));
    const bad = structuredClone(delivery);
    bad.roleAssignment.record.Draft.TextProjectionRoot = '0'.repeat(64);
    assert.throws(() => read(bad));
    if (delivery.roleAssignment.successorViewerPolicy) {
      const substitute = structuredClone(delivery);
      substitute.roleAssignment.successorViewerPolicy.recipient.statement.firstPosition++;
      assert.throws(() => read(substitute));
    }
  }
  const withoutSurvivor = structuredClone(task);
  delete withoutSurvivor.Recipients[unrelatedDevice];
  assert.throws(() => verify(withoutSurvivor));
  const replaced = structuredClone(task);
  replaced.Recipients[unrelatedDevice].PublicKey = '0'.repeat(64);
  assert.throws(() => verify(replaced));
  const extra = structuredClone(task);
  extra.Recipients['1'.repeat(64)] = task.Recipients[unrelatedDevice];
  assert.throws(() => verify(extra));
  if (revoked) {
    const forgedRemoval = { ...evidence, removedGroup: { ...evidence.removedGroup, digest: '0'.repeat(64) } };
    assert.throws(() => verify(task, forgedRemoval));
  } else {
    const replacedTarget = structuredClone(task);
    replacedTarget.Recipients[verified.after[task.Purpose][0].id].PublicKey = '0'.repeat(64);
    assert.throws(() => verify(replacedTarget));
  }
}

const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const identity = (deviceId, seed) => ({ deviceId, device: createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]),
  type: 'pkcs8', format: 'der',
}) });
function addressed(deliveries, committed, deviceId) {
  const template = deliveries.find(({ recipient }) => recipient.recipientId === deviceId).delivery;
  const packages = [...committed.Packages].sort((left, right) => left.RecipientID.localeCompare(right.RecipientID));
  const index = packages.findIndex(item => item.RecipientID === deviceId);
  const item = packages[index], siblings = [];
  let path = index;
  let leaves = packages.map(entry => sha(Buffer.from([0, entry.Purpose === 'live' ? 1 : 0]),
    Buffer.from(entry.RecipientID, 'hex'), Buffer.from(entry.Ciphertext, 'base64')));
  while (leaves.length > 1) {
    if (leaves[path ^ 1]) siblings.push(leaves[path ^ 1].toString('hex'));
    const next = [];
    for (let offset = 0; offset < leaves.length; offset += 2) {
      next.push(leaves[offset + 1] ? sha(Buffer.from([1]), leaves[offset], leaves[offset + 1]) : leaves[offset]);
    }
    leaves = next;
    path = Math.floor(path / 2);
  }
  return { ...template, Epoch: { ...template.Epoch, Record: committed.Record }, Package: item,
    Proof: { index, count: packages.length, siblings } };
}

const { serverId } = transition.trust;
const channelId = transition.channelId;
const policyTrust = { ...transition.trust, anchorDigest: '1'.repeat(64), ownerProfileId: '1'.repeat(64) };
function setup(profileId, deviceId, seed) {
  const values = new Map([[deviceAgreementKeySlot(serverId, deviceId), Buffer.alloc(32, seed).toString('hex')]]);
  const client = new MembershipClient({ credentials: {
    load: async key => values.get(key), save: async (key, value) => values.set(key, value),
  } });
  const connection = { policyTrust, serverId, profileId, deviceId, base: 'https://test.invalid', token: 'test' };
  client.identity = async () => identity(deviceId, seed);
  // Supply the already verified predecessor at the attestation boundary.
  client.policyCheckpoint = () => ({ load: async () => undefined });
  client.readProtectedPolicyAttestation = async (_connection, revision, options) => {
    if (revision === undefined) throw Object.assign(Error('unavailable'), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
    assert.equal(revision, attestation.revision);
    if (options) assert.equal(options.expectedCurrentHead, attestation.digest);
    return attestation;
  };
  return { client, connection };
}
async function checkClientRotation(live, archive) {
  const { client, connection } = setup(publisher.profileId, publisher.deviceId, 19);
  const commits = {};
  const reconciled = [];
  let tamper = true;
  let message;
  client.fetchJSON = async (_base, path, request) => {
    for (const fixture of [live, archive]) {
      const purpose = fixture.task.Purpose;
      const prefix = '/api/v3/keys/rotate/' + channelId + '/' + purpose;
      if (path === prefix + '/claim?scoped=1&transition=1') {
        const task = { ...structuredClone(fixture.task), Generation: 1, PreviousDigest: '',
          TaskID: '1'.repeat(32), LeaseID: '2'.repeat(32) };
        if (tamper) delete task.Recipients[unrelatedDevice];
        if (purpose === 'archive') {
          task.ArchiveThrough = 1;
          task.ArchiveTargets = [{ Purpose: 'live', Generation: 1, KeyID: commits.live.Record.KeyID,
            EpochDigest: sha(Buffer.from(commits.live.Record.Signature, 'base64')).toString('hex') }];
        }
        return task;
      }
      if (path === prefix + '/commit') {
        assert.equal(tamper, false);
        const committed = JSON.parse(request.body);
        assert.equal(committed.Record[purpose === 'live' ? 'LiveTransitionDigest' : 'ArchiveTransitionDigest'], fixture.marker);
        assert.deepEqual(committed.Packages.map(item => item.RecipientID).sort(), Object.keys(fixture.task.Recipients).sort());
        commits[purpose] = committed;
        if (purpose === 'live') throw Object.assign(Error('response lost after commit'), { code: 'CONNECTION_FAILED' });
        return { generation: committed.Record.Generation, keyId: committed.Record.KeyID,
          signatureDigest: sha(Buffer.from(committed.Record.Signature, 'base64')).toString('hex') };
      }
    }
    const ownLive = () => addressed(live.deliveries, commits.live, publisher.deviceId);
    if (path === '/api/v3/keys/proofs/' + channelId + '/live?after=0&through=1&scoped=1') {
      const { Epoch, roleAssignment } = ownLive();
      reconciled.push(Epoch.Record.Generation);
      return [{ ...Epoch, roleAssignment }];
    }
    if (path === '/api/v3/keys/current/' + channelId + '/live?scoped=1') return ownLive();
    if (path === '/api/v3/keys/rotate/' + channelId + '/targets?scoped=1') return [ownLive()];
    if (path === '/api/v3/history/live/' + channelId + '?after=0&limit=32&scoped=1') return { first: 1, messages: [message] };
    assert.fail(path);
  };
  await assert.rejects(client.rotateProtectedRuntimeText(connection, channelId, 'live'), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  tamper = false;
  await client.rotateProtectedRuntimeText(connection, channelId, 'live');
  assert.deepEqual(reconciled, [1]);
  await client.rotateProtectedRuntimeText(connection, channelId, 'archive');
  assert.equal(commits.archive.Links.length, 1);
  const target = live.deliveries.find(({ recipient }) => recipient.recipientId === transition.expectedKey)?.recipient;
  if (!target) return;
  const reader = setup(target.profileId, target.recipientId, 20);
  for (const fixture of [live, archive]) {
    const purpose = fixture.task.Purpose;
    const sealed = addressed(fixture.deliveries, commits[purpose], target.recipientId);
    reader.client.fetchJSON = async () => sealed;
    const opened = await reader.client.loadProtectedRuntimeKey(reader.connection, channelId, purpose, { policyTrust });
    assert.equal(sha(opened.secret).toString('hex'), commits[purpose].Record.KeyID);
    if (purpose === 'live' && live.newAuthorKey) {
      const Author = { DeviceID: target.recipientId, ProfileID: target.profileId };
      const AuthorPolicy = sealed.roleAssignment.successorViewerPolicy;
      const Packet = sealProtectedText(opened.secret, serverId, Author,
        { ChannelID: channelId, KeyID: opened.record.KeyID, OperationID: '7'.repeat(32) }, 'first protected message',
        identity(target.recipientId, 20).device);
      message = { Author, AuthorPolicy, Packet, Position: AuthorPolicy.recipient.statement.firstPosition,
        Generation: opened.record.Generation, SentAt: 1, roleAssignmentAuthorKey: live.newAuthorKey };
      client.readProtectedImportedHistory = async () => ({ first: 1, messages: [] });
      client.readProtectedHistoryWindow = async () => ({ first: 1, cursor: '', more: false, removed: [], edits: [] });
      const page = await client.readProtectedChatPage(connection, channelId, 0, '');
      assert.equal(page.messages[0].text, 'first protected message');
      message.roleAssignmentAuthorKey = { ...live.newAuthorKey, publicKey: '0'.repeat(64) };
      await assert.rejects(client.readProtectedChatPage(connection, channelId, 0, ''));
    }
    opened.secret.fill(0);
    sealed.roleAssignment.successorViewerPolicy.recipient.statement.firstPosition++;
    await assert.rejects(reader.client.loadProtectedRuntimeKey(reader.connection, channelId, purpose, { policyTrust }));
  }
}
async function checkArchiveOnly(fixture, existingArchive, waitForLive = false) {
  const { client, connection } = setup(publisher.profileId, publisher.deviceId, 19);
  const own = fixture.deliveries.find(({ recipient }) => recipient.recipientId === publisher.deviceId);
  const principal = own.delivery.Epoch.Principal;
  const signingPolicy = own.delivery.roleAssignment.previousSignerTextPolicy;
  const recipient = fixture.task.Recipients[publisher.deviceId];
  const basis = { ...fixture.task, Generation: 1, PreviousDigest: '', TaskID: '3'.repeat(32), LeaseID: '4'.repeat(32),
    Revision: attestation.revision, PolicyDigest: attestation.policyDigest, Recipients: { [publisher.deviceId]: recipient } };
  const args = { serverId, channelId, profileId: publisher.profileId, identity: identity(publisher.deviceId, 19) };
  const epochDelivery = (committed, deviceId = publisher.deviceId) => {
    const Epoch = { Principal: principal, signingPolicy };
    return addressed([{ delivery: { Epoch }, recipient: { recipientId: deviceId } }], committed, deviceId);
  };
  const liveRecipients = { ...basis.Recipients };
  if (fixture.liveHistory) liveRecipients[fixture.liveHistory.deviceId] = fixture.liveHistory.recipient;
  let live, prevArchive, liveCommit;
  await runLiveRotation({ ...args, claim: async () => ({ ...basis, Purpose: 'live', Recipients: liveRecipients }), authorizeTask: async () => {},
    commit: async (Record, Packages) => { liveCommit = { Record, Packages }; live = epochDelivery(liveCommit); } });
  const targetFor = ({ Epoch: { Record: record } }) => ({ Purpose: record.Purpose, Generation: record.Generation, KeyID: record.KeyID });
  const signatureDigest = ({ Signature }) => sha(Buffer.from(Signature, 'base64')).toString('hex');
  if (existingArchive) {
    const { deviceAgreementPrivateKey } = require(base + 'protected-device-agreement.cjs');
    await runArchiveRotation({ ...args, claim: async () => ({ ...basis, ArchiveThrough: 1, ArchiveTargets: [targetFor(live)] }),
      privateKey: deviceAgreementPrivateKey(Buffer.alloc(32, 19).toString('hex')),
      authorizeTask: async () => {}, loadTargets: async () => [live],
      authorizeEpoch: async () => ({ ...publisher, key: signingPolicy.recipient.statement.signingKey }),
      commit: async (Record, Packages) => { prevArchive = epochDelivery({ Record, Packages }); } });
  }
  const source = prevArchive ?? live;
  const task = { ...fixture.task, Generation: existingArchive ? 2 : 1, PreviousDigest: prevArchive ? signatureDigest(prevArchive.Epoch.Record) : '',
    TaskID: '5'.repeat(32), LeaseID: '6'.repeat(32), ArchiveThrough: 1, ArchiveTargets: [targetFor(source)] };
  let committed;
  const forgedHead = structuredClone(live);
  forgedHead.Epoch.Record.Signature = Buffer.alloc(64, 1).toString('base64');
  let useValidHead = waitForLive;
  client.fetchJSON = async (_base, path, options) => {
    if (path === '/api/v3/keys/rotate/' + channelId + '/archive/claim?scoped=1&transition=1') return task;
    if (path === '/api/v3/keys/current/' + channelId + '/live?scoped=1') return useValidHead ? live : forgedHead;
    if (path === '/api/v3/keys/proofs/' + channelId + '/archive?after=0&through=1&scoped=1') return [prevArchive.Epoch];
    if (path === '/api/v3/keys/rotate/' + channelId + '/targets?scoped=1') return [source];
    if (path === '/api/v3/keys/rotate/' + channelId + '/archive/commit') {
      committed = JSON.parse(options.body);
      return { generation: committed.Record.Generation, keyId: committed.Record.KeyID,
        signatureDigest: signatureDigest(committed.Record) };
    }
    assert.fail(path);
  };
  if (waitForLive) {
    await assert.rejects(client.rotateProtectedRuntimeText(connection, channelId, 'archive'), { code: 'PROTECTED_KEY_PENDING' });
    assert.equal(committed, undefined);
    return;
  }
  await assert.rejects(client.rotateProtectedRuntimeText(connection, channelId, 'archive'), /INVALID_EPOCH_SIGNATURE/);
  assert.equal(committed, undefined);
  useValidHead = true;
  await client.rotateProtectedRuntimeText(connection, channelId, 'archive');
  assert.equal(committed.Record.ArchiveTransitionDigest, fixture.marker);
  assert.equal(committed.Record.ArchiveThrough, 1);
  assert.deepEqual(committed.Links.map(({ Purpose, Generation, KeyID }) => ({ Purpose, Generation, KeyID })), [targetFor(source)]);
  const target = fixture.deliveries.find(({ delivery }) => delivery.roleAssignment.successorViewerPolicy)?.recipient;
  if (target) {
    const reader = setup(target.profileId, target.recipientId, 23);
    const sealed = addressed(fixture.deliveries, committed, target.recipientId);
    reader.client.fetchJSON = async (_base, path) => {
      assert.equal(path, '/api/v3/keys/current/' + channelId + '/archive?scoped=1');
      return sealed;
    };
    const opened = await reader.client.loadProtectedRuntimeKey(reader.connection, channelId, 'archive', { policyTrust });
    assert.equal(sha(opened.secret).toString('hex'), committed.Record.KeyID);
    opened.secret.fill(0);
  }
  const history = fixture.liveHistory;
  const viewer = setup(history.recipient.ProfileID, history.deviceId, history.granted ? 23 : 21);
  const oldLive = epochDelivery(liveCommit, history.deviceId);
  const liveRoleHistory = { ...history.proof, archive: { ...history.proof.archive, Record: committed.Record } };
  const response = { ...oldLive, textPolicy: history.textPolicy, liveRoleHistory };
  viewer.client.fetchJSON = async () => response;
  const opened = await viewer.client.loadProtectedRuntimeKey(viewer.connection, channelId, 'live', { policyTrust });
  assert.equal(sha(opened.secret).toString('hex'), liveCommit.Record.KeyID);
  opened.secret.fill(0);
  assert.equal(opened.liveTransition.admission.archive, history.granted);
  assert.equal(opened.liveTransition.admission.firstPosition, 1);
  assert.equal(opened.liveTransition.policy.revision, attestation.revision + 1);
  const invalidWitness = structuredClone(response);
  invalidWitness.liveRoleHistory.archive.Record.Signature = Buffer.alloc(64, 1).toString('base64');
  viewer.client.fetchJSON = async () => invalidWitness;
  await assert.rejects(viewer.client.loadProtectedRuntimeKey(viewer.connection, channelId, 'live', { policyTrust }), /INVALID_EPOCH_SIGNATURE/);
  viewer.client.readProtectedPolicyAttestation = async () => attestation;
  viewer.client.fetchJSON = async () => ({ ...oldLive, textPolicy: liveRoleHistory.transition.previousViewerTextPolicy });
  await assert.rejects(viewer.client.loadProtectedRuntimeKey(viewer.connection, channelId, 'live', { policyTrust }), { code: 'POLICY_ROLLBACK' });
}
async function checkRuntime() {
  for (let index = 0; index < 4; index += 2) {
    await checkClientRotation(rotations[index], rotations[index + 1]);
  }
  for (const fixture of rotations.slice(4)) {
    for (const existingArchive of [false, true]) await checkArchiveOnly(fixture, existingArchive);
  }
  await checkArchiveOnly(rotations[1], false, true);
}
checkRuntime().catch(error => { console.error(error); process.exitCode = 1; });
`)
	command.Stdin = bytes.NewReader(payload)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Electron channel rule verification: %v\n%s", err, output)
	}
}
