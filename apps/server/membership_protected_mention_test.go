package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedMentionsAuthorizeAtMessageCommit(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var hidden memberSession
	store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		role := state.Roles["reader"]
		role.Grants = append(role.Grants, "mention.mass")
		state.Roles["reader"] = role
		state.Roles["quiet"] = access.Role{}
		state.Order = append(state.Order, "quiet")
		for id, member := range state.Members {
			if id != state.Owner {
				member.Roles = append(member.Roles, "quiet")
				state.Members[id] = member
			}
		}
		state.RolePresentation = map[string]access.RolePresentation{
			"reader": {Name: "Readers", Mentionable: true},
			"quiet":  {Name: "Quiet"},
		}
		signer := newTestMemberSigner(3)
		activateTestMember(t, server, signer, "member")
		hidden = loginTestMember(t, server, signer)
		profile, device := hidden.Access.EffectiveProfileID, hidden.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{"reader"}}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 33)}
		channel := state.Channels["private"]
		channel.ACL.Profiles = map[string]access.Overwrite{profile: {Deny: []string{access.ChannelView}}}
		state.Channels["private"] = channel
	})
	commit := func(draft access.PolicyDraft) {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, owner.Token, draft)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview)); err != nil {
			t.Fatal(err)
		}
	}
	commit(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	const channel = "private"
	checkOptions := func(mass bool) {
		t.Helper()
		if err := store.DispatchMentionRoster(ctx, server.protectedSession(reader.Token), channel, "", 0, func(_ access.SessionQuery, page access.RosterPage) error {
			if len(page.Members) != 2 || page.Mentions == nil || !page.Mentions.Available || page.Mentions.Mass != mass ||
				!slices.Equal(page.Mentions.Roles, []string{"reader"}) {
				t.Fatalf("scoped mention options: %+v, flags %+v", page.Members, page.Mentions)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	checkOptions(true)
	key := strings.Repeat("a", 64)
	epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, key)
	if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
		t.Fatal(err)
	}
	packet := func(operation byte, targets ...access.MentionTarget) access.MessageAttempt {
		t.Helper()
		salt := strings.Repeat("2", 64)
		fields := []string{"pawtalk-protected-mentions-v1", salt}
		for _, target := range targets {
			fields = append(fields, target.Kind, target.ID)
		}
		frame, err := signatureFrame(fields...)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(frame)
		return signProtectedTestMessage(t, server, reader, 2, access.MessageAttempt{
			ChannelID: channel, OperationID: fmt.Sprintf("%032x", operation), KeyID: key, Nonce: bytes.Repeat([]byte{operation}, 12), Ciphertext: make([]byte, 17),
			MentionRouting: &access.MentionRouting{Salt: salt, Targets: targets}, MentionDigest: hex.EncodeToString(digest[:]),
		})
	}
	appendPacket := func(attempt access.MessageAttempt) (access.MessageReceipt, error) {
		return server.appendProtectedMessage(ctx, reader.Token, attempt)
	}
	accepted := packet(1, access.MentionTarget{Kind: "role", ID: "reader"}, access.MentionTarget{Kind: "profile", ID: owner.Access.EffectiveProfileID})
	if receipt, err := appendPacket(accepted); err != nil || receipt.Position != 1 || receipt.Existing {
		t.Fatalf("mentionable role and visible profile: %+v %v", receipt, err)
	}
	if _, err := appendPacket(packet(2, access.MentionTarget{Kind: "role", ID: "quiet"})); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("unmentionable role without privilege: %v", err)
	}
	if _, err := appendPacket(packet(3, access.MentionTarget{Kind: "role", ID: access.Everyone})); !errors.Is(err, access.InvalidAction) {
		t.Fatalf("bypassed mass permission via role alias: %v", err)
	}
	if _, err := appendPacket(packet(4, access.MentionTarget{Kind: "profile", ID: strings.Repeat("0", 64)})); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("accepted an unavailable profile: %v", err)
	}
	if _, err := appendPacket(packet(11, access.MentionTarget{Kind: "profile", ID: hidden.Access.EffectiveProfileID})); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("direct mention accepted actual member outside channel scope: %v", err)
	}
	approved := packet(5, access.MentionTarget{Kind: "everyone"})
	tampered := packet(6, access.MentionTarget{Kind: "online"})
	tampered.MentionRouting.Targets[0].Kind = "everyone"
	if _, err := appendPacket(tampered); !errors.Is(err, access.InvalidAction) {
		t.Fatalf("substituted routing targets: %v", err)
	}
	if receipt, err := appendPacket(approved); err != nil || receipt.Position != 2 {
		t.Fatalf("mass mention: %+v %v", receipt, err)
	}
	readInbox := func(session memberSession, after string) access.MentionInbox {
		t.Helper()
		var result access.MentionInbox
		if err := store.DispatchMentionInbox(ctx, server.protectedSession(session.Token), after, func(page access.MentionInbox) error {
			result = page
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if inbox := readInbox(hidden, ""); len(inbox.Alerts) != 0 || inbox.Cursor != "" {
		t.Fatalf("hidden member received role or mass alerts: %+v", inbox)
	}
	online := access.MentionTarget{Kind: "online"}
	if receipt, err := appendPacket(packet(8, online)); err != nil || receipt.Position != 3 {
		t.Fatalf("online mention before activity: %+v %v", receipt, err)
	}
	ownerInbox := readInbox(owner, "")
	if !slices.Equal(ownerInbox.Alerts, []access.MentionAlert{
		{ChannelID: channel, Position: 1, Kind: "direct"}, {ChannelID: channel, Position: 2, Kind: "group"},
	}) || ownerInbox.Cursor == "" {
		t.Fatalf("recipient inbox: %+v", ownerInbox)
	}
	if senderInbox := readInbox(reader, ownerInbox.Cursor); len(senderInbox.Alerts) != 0 || senderInbox.Cursor != "" {
		t.Fatalf("sender received a self mention or another profile's inbox: %+v", senderInbox)
	}
	if err := store.DispatchMentionEligibility(ctx, server.protectedSession(owner.Token), channel, 1, func(result access.MentionEligibility) error {
		if result.Kind != "direct" || result.Revision != 1 || result.Remaining < 1 || result.Remaining > 30_000 {
			t.Fatalf("invalid direct notification authorization: %+v", result)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.DispatchMentionEligibility(ctx, server.protectedSession(reader.Token), channel, 1, func(access.MentionEligibility) error {
		t.Fatal("show authorized another profile's notification")
		return nil
	}); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("notification authorization disclosed another profile: %v", err)
	}
	if receipt, err := appendPacket(packet(9, online)); err != nil || receipt.Position != 4 {
		t.Fatalf("online mention after activity: %+v %v", receipt, err)
	}
	onlineInbox := readInbox(owner, ownerInbox.Cursor)
	if !slices.Equal(onlineInbox.Alerts, []access.MentionAlert{{ChannelID: channel, Position: 4, Kind: "group"}}) {
		t.Fatalf("online inbox: %+v", onlineInbox)
	}
	var count int
	if err := server.db.QueryRow(`SELECT count(*) FROM protected_mention_alerts WHERE profile_id=?`, hidden.Access.EffectiveProfileID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("offline, online or role routing addressed an excluded recipient: %d, %v", count, err)
	}
	toReader := packet(10, access.MentionTarget{Kind: "profile", ID: reader.Access.EffectiveProfileID})
	toReader = signProtectedTestMessage(t, server, owner, 1, toReader)
	if receipt, err := server.appendProtectedMessage(ctx, owner.Token, toReader); err != nil || receipt.Position != 5 {
		t.Fatalf("direct mention to reader: %+v %v", receipt, err)
	}
	if inbox := readInbox(reader, ""); !slices.Equal(inbox.Alerts, []access.MentionAlert{{ChannelID: channel, Position: 5, Kind: "direct"}}) {
		t.Fatalf("direct recipient inbox: %+v", inbox)
	}
	draft := packet(7, access.MentionTarget{Kind: "online"})
	role := state.Roles["reader"]
	role.Grants = slices.DeleteFunc(role.Grants, func(grant string) bool { return grant == "mention.mass" })
	state.Roles["reader"] = role
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	checkOptions(false)
	if _, err := appendPacket(draft); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("mention approved after permission loss: %v", err)
	}
	if receipt, err := appendPacket(approved); err != nil || !receipt.Existing || receipt.Position != 2 {
		t.Fatalf("committed operation lost its idempotent receipt: %+v %v", receipt, err)
	}
	if err := store.DispatchLiveMessages(ctx, server.protectedSession(owner.Token), channel, 0, 32, nil, false, func(page access.LiveMessagePage) error {
		if len(page.Messages) != 5 || page.Messages[0].Packet.MentionDigest != accepted.MentionDigest ||
			page.Messages[0].Packet.MentionRouting != nil || page.Messages[1].Packet.MentionRouting != nil {
			t.Fatalf("history altered the digest or exposed raw routing: %+v", page.Messages)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteMessage(ctx, server.protectedSession(owner.Token), nil, channel, 2); err != nil {
		t.Fatal(err)
	}
	if err := store.DispatchMentionEligibility(ctx, server.protectedSession(owner.Token), channel, 2, func(access.MentionEligibility) error {
		t.Fatal("deleted original authorized a notification")
		return nil
	}); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("deleted notification authorization: %v", err)
	}
	for _, alert := range readInbox(owner, "").Alerts {
		if alert.Position == 2 {
			t.Fatalf("deleted original retained an alert: %+v", alert)
		}
	}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("3", 32), RoleUpdate: &access.RolePolicyUpdate{
		Roles: state.Roles, Order: state.Order, Assignments: map[string][]string{reader.Access.EffectiveProfileID: nil},
	}})
	if inbox := readInbox(reader, ""); len(inbox.Alerts) != 0 {
		t.Fatalf("revoked reader received alerts for an inaccessible original: %+v", inbox)
	}
	if err := server.db.QueryRow(`SELECT count(*) FROM protected_message_mentions`).Scan(&count); err != nil || count != 4 {
		t.Fatalf("deleted mentions or duplicate retry retained routing: count=%d error=%v", count, err)
	}
	afterExpiry := access.NewStoreWithClock(server.db, func() time.Time { return server.now().Add(31 * time.Second) })
	if err := afterExpiry.DispatchMentionInbox(ctx, server.protectedSession(owner.Token), "", func(page access.MentionInbox) error {
		if len(page.Alerts) != 0 {
			t.Fatalf("an expired mention was delivered: %+v", page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
