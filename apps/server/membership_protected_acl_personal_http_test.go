package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedChannelACLPersonalScopeAndRetry(t *testing.T) {
	for _, version := range []int{access.ChannelACLProjectionVersion, access.ProfileRankProjectionVersion, access.ProfileACLBypassProjectionVersion} {
		t.Run(strconv.Itoa(version), func(t *testing.T) { testProtectedChannelACLPersonalScopeAndRetry(t, version) })
	}
}

func testProtectedChannelACLPersonalScopeAndRetry(t *testing.T, version int) {
	ctx := context.Background()
	server := testMembershipStore(t)
	const (
		channel  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		category = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		sibling  = "cccccccccccccccccccccccccccccccc"
		missing  = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	)
	var target, peer, hidden, known string
	store, _, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		add := func(seed byte, roles ...string) string {
			identity := activateTestMember(t, server, newTestMemberSigner(seed), "member")
			state.Members[identity.ProfileID] = access.Subject{ID: identity.ProfileID, Active: true, Roles: roles}
			state.PolicyDevices[identity.DeviceID] = access.PolicyDevice{ProfileID: identity.ProfileID, PublicKey: testSigningKey(seed)}
			state.KeyRecipients[identity.DeviceID] = access.KeyRecipient{ProfileID: identity.ProfileID, Kind: "device",
				PublicKey: testRecipientKey(t, seed+20)}
			return identity.ProfileID
		}
		state.Order = []string{"guest", "reader"}
		state.Roles["guest"] = access.Role{Grants: []string{access.ChannelView}}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "channel.access.edit"}}
		target, peer, hidden, known = add(3, "guest"), add(4, "reader"), add(5), add(6, "guest")
		state.Categories = map[string]access.ACL{category: {
			Roles: map[string]access.Overwrite{"reader": {Allow: []string{"voice.speak"}, Deny: []string{"message.send"}}},
			Profiles: map[string]access.Overwrite{
				target: {Allow: []string{"message.attach"}, Deny: []string{}},
				known:  {Deny: []string{access.ChannelView}},
			},
		}}
		state.Channels = map[string]access.Channel{
			channel: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 1},
			sibling: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 1},
		}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, version)
	ownerToken, readerToken := open(owner, 1), open(reader, 2)
	var pending access.PendingPolicyAttestations
	if err := json.Unmarshal(call(http.MethodGet, "/api/v3/policy/attestations/pending", ownerToken, nil, http.StatusOK), &pending); err != nil ||
		len(pending.Revisions) != 1 || pending.Revisions[0] != anchor.Draft.Revision || pending.HeadDigest != anchor.Digest {
		t.Fatalf("initial v%d policy is missing from pending attestation work: %+v, %v", version, pending, err)
	}
	path := "/api/v3/policy/channel-acl/" + channel + "/personal"
	get := func(token, profile string, status int) []byte {
		t.Helper()
		return call(http.MethodGet, path+"/"+profile, token, nil, status)
	}
	disclosed := func(token, profile string) access.ChannelACLPersonalDisclosure {
		t.Helper()
		raw := get(token, profile, http.StatusOK)
		var result access.ChannelACLPersonalDisclosure
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &result); err != nil || result.ChannelID != channel || result.ProfileID != profile {
			t.Fatalf("unexpected personal disclosure: %s, %v", raw, err)
		}
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("unexpected disclosure fields: %s, %v", raw, err)
		}
		if version == access.ChannelACLProjectionVersion {
			if len(fields) != 5 || result.RankBasis != nil {
				t.Fatalf("v10 unexpectedly disclosed rank basis: %s", raw)
			}
		} else {
			actor, actorRank := reader.Access.EffectiveProfileID, 2
			if token == ownerToken {
				actor, actorRank = owner.Access.EffectiveProfileID, 3
			}
			targetRank := 1
			if profile == hidden {
				targetRank = 0
			}
			basis := result.RankBasis
			if len(fields) != 6 || basis == nil || !validHexID(basis.Root, 64) || len(basis.Inclusion.Siblings) != 10 ||
				basis.Actor.ProfileID != actor || basis.Actor.Rank != actorRank || basis.Target.ProfileID != profile ||
				basis.Target.Rank != targetRank || len(basis.Actor.Path) == 0 || len(basis.Target.Path) == 0 {
				t.Fatalf("invalid v%d rank proof: %s", version, raw)
			}
			if version == access.ProfileACLBypassProjectionVersion {
				if basis.Actor.BypassesACL == nil || *basis.Actor.BypassesACL != (token == ownerToken) ||
					basis.Target.BypassesACL == nil || *basis.Target.BypassesACL {
					t.Fatalf("incorrect ACL bypass disclosure: %s", raw)
				}
			} else if basis.Actor.BypassesACL != nil || basis.Target.BypassesACL != nil {
				t.Fatalf("v11 unexpectedly disclosed ACL bypass: %s", raw)
			}
			for _, id := range []string{peer, hidden, known, owner.Access.EffectiveProfileID, reader.Access.EffectiveProfileID} {
				if id != actor && id != profile && bytes.Contains(raw, []byte(id)) {
					t.Fatalf("personal rank proof revealed another profile: %s", id)
				}
			}
		}
		return result
	}
	before := disclosed(readerToken, target)
	if before.PolicyHead != anchor.Digest || before.Revision != 1 || before.Rules == nil ||
		len(before.Rules.Allow) != 1 || before.Rules.Allow[0] != "message.attach" ||
		before.Rules.Deny == nil || len(before.Rules.Deny) != 0 {
		t.Fatalf("incorrect targeted override: %+v", before)
	}
	if result := disclosed(readerToken, known); result.Rules == nil || len(result.Rules.Deny) != 1 || result.Rules.Deny[0] != access.ChannelView {
		t.Fatalf("known scoped override inaccessible: %+v", result)
	}
	if result := disclosed(ownerToken, hidden); result.Rules != nil {
		t.Fatalf("member.list should allow lookup without disclosing another rule: %+v", result)
	}
	denied := get(readerToken, missing, http.StatusForbidden)
	for _, profile := range []string{hidden, peer, owner.Access.EffectiveProfileID} {
		if output := get(readerToken, profile, http.StatusForbidden); !bytes.Equal(output, denied) {
			t.Fatalf("unauthorized profile presence leaked: %s versus %s", output, denied)
		}
	}

	activeOwner := owner
	activeOwner.Token = ownerToken
	epoch, packages := prepareTestEpoch(t, server, activeOwner, 1, channel, strings.Repeat("8", 64))
	if err := server.commitProtectedEpoch(ctx, ownerToken, epoch, packages); err != nil {
		t.Fatal(err)
	}
	request := func(operation, profile, policyHead string, revision int64, permission, rule string, seed byte) []byte {
		t.Helper()
		operation = strings.Repeat(operation, 32)
		frame, err := signatureFrame("pawtalk-protected-channel-acl-personal-edit-v1", runtime.serverID, runtime.cutoverDigest,
			reader.Access.EffectiveProfileID, reader.Access.DeviceID, operation, strconv.FormatInt(revision, 10),
			policyHead, channel, "text", category, profile, permission, rule)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(map[string]string{"operationId": operation, "policyHead": policyHead,
			"targetProfileId": profile, "permission": permission, "rule": rule,
			"editorProof": b64.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	post := func(body []byte, status int) []byte {
		t.Helper()
		return call(http.MethodPost, path, readerToken, body, status)
	}
	for _, profile := range []string{hidden, missing, peer} {
		if output := post(request("2", profile, anchor.Digest, 1, access.ChannelView, "deny", 2), http.StatusForbidden); !bytes.Equal(output, denied) {
			t.Fatalf("mutation exposed unauthorized target: %s", output)
		}
	}
	post(request("3", target, anchor.Digest, 1, "voice.speak", "deny", 2), http.StatusBadRequest)
	post(request("4", target, anchor.Digest, 1, "message.attach", "allow", 2), http.StatusBadRequest)
	if output := post(request("5", target, anchor.Digest, 1, access.ChannelView, "deny", 3), http.StatusForbidden); !bytes.Contains(output, []byte("INVALID_PROTECTED_CHANNEL_ACL_PERSONAL_EDIT")) {
		t.Fatalf("wrong-signature rejection: %s", output)
	}
	edit := request("6", target, anchor.Digest, 1, access.ChannelView, "deny", 2)
	first := post(edit, http.StatusOK)
	if again := post(edit, http.StatusOK); !bytes.Equal(first, again) {
		t.Fatalf("retry changed receipt: %s versus %s", first, again)
	}
	post(request("6", target, anchor.Digest, 1, access.ChannelView, "inherit", 2), http.StatusConflict)
	post(request("7", target, anchor.Digest, 1, access.ChannelView, "deny", 2), http.StatusConflict)
	after := disclosed(readerToken, target)
	if after.PolicyHead == anchor.Digest || after.Revision != 2 || after.Rules == nil ||
		len(after.Rules.Allow) != 1 || after.Rules.Allow[0] != "message.attach" ||
		len(after.Rules.Deny) != 1 || after.Rules.Deny[0] != access.ChannelView {
		t.Fatalf("incorrect scoped override after mutation: %+v", after)
	}
	snapshot, revision, err := store.Snapshot(ctx)
	if err != nil || revision != 2 {
		t.Fatalf("read updated policy: revision %d, %v", revision, err)
	}
	resource := snapshot.Channels[channel]
	if resource.Synchronized || snapshot.CanDeliver(target, channel, 0) || !snapshot.CanDeliver(target, sibling, 0) ||
		!snapshot.Channels[sibling].Synchronized || len(resource.ACL.Profiles[known].Deny) != 1 ||
		len(resource.ACL.Roles["reader"].Deny) != 1 || len(resource.ACL.Roles["reader"].Allow) != 0 ||
		len(snapshot.Categories[category].Roles["reader"].Allow) != 1 || snapshot.EpochWindows[channel].CurrentCutoff == 0 {
		t.Fatalf("scoped mutation changed unrelated ACL/channel state: %+v", resource)
	}
	var audit, rotation int
	if err := server.db.QueryRow(`SELECT (SELECT count(*) FROM protected_audit_events WHERE channel_id=? AND object_id=? AND action=?),
		(SELECT count(*) FROM protected_rotation_tasks WHERE channel_id=? AND purpose='live' AND revision=2)`,
		channel, target, access.UpdateChannelACL, channel).Scan(&audit, &rotation); err != nil || audit != 1 || rotation != 1 {
		t.Fatalf("personal commit did not atomically record audit and live rotation: %d, %d, %v", audit, rotation, err)
	}
	post(request("8", target, after.PolicyHead, after.Revision, access.ChannelView, "inherit", 2), http.StatusOK)
	lifted := disclosed(readerToken, target)
	if lifted.Revision != 3 || lifted.Rules == nil || lifted.Rules.Deny != nil ||
		len(lifted.Rules.Allow) != 1 || lifted.Rules.Allow[0] != "message.attach" {
		t.Fatalf("lift lost another rule or signed nil representation: %+v", lifted)
	}
	post(request("9", known, lifted.PolicyHead, lifted.Revision, "message.pin", "deny", 2), http.StatusOK)
	knownAfter := disclosed(readerToken, known)
	if knownAfter.Revision != 4 || knownAfter.Rules == nil || len(knownAfter.Rules.Deny) != 2 ||
		knownAfter.Rules.Deny[0] != access.ChannelView || knownAfter.Rules.Deny[1] != "message.pin" {
		t.Fatalf("existing hidden association did not preserve its other permission: %+v", knownAfter)
	}
}
