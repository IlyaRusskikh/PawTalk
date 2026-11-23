package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

type fanoutDevice struct {
	profile, id, token string
	signing            ed25519.PrivateKey
}

type fanoutRotation struct {
	Record   access.EpochRecord
	Packages []access.EpochPackage
	Links    []access.ArchiveLink
}

// Exercise real signing, session resolution, SQLite commits and Electron's key
// packaging on a synthetic cohort. No test fixture reaches a live network.
func TestProtectedRoleFanoutAndConcurrentSends(t *testing.T) {
	if os.Getenv("PAWTALK_TEST_PROTECTED_FANOUT") != "1" {
		t.Skip("set PAWTALK_TEST_PROTECTED_FANOUT=1 for the KEY-18 workload")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-fanout-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	const deviceCount, channelCount, firstRevoked, totalRevoked = 240, 12, 180, 204
	channels, devices := make([]string, channelCount), make([]fanoutDevice, deviceCount)
	server := testMembershipStore(t)
	base := server.now()
	var millis atomic.Int64
	server.now = func() time.Time { return base.Add(time.Duration(millis.Load()) * time.Millisecond) }
	policy, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		delete(state.Channels, "private")
		for i := range channels {
			channels[i] = fmt.Sprintf("%032x", i+1)
			state.Channels[channels[i]] = access.Channel{Kind: "text", NextPosition: 1}
		}
		for i := range devices {
			seed := sha256.Sum256([]byte(fmt.Sprintf("fanout signing %d", i)))
			signing := ed25519.NewKeyFromSeed(seed[:])
			public := signing.Public().(ed25519.PublicKey)
			seed = sha256.Sum256([]byte(fmt.Sprintf("fanout agreement %d", i)))
			agreement, err := ecdh.X25519().NewPrivateKey(seed[:])
			if err != nil {
				t.Fatal(err)
			}
			profile, id := publicKeyID([]byte(fmt.Sprintf("fanout profile %d", i))), publicKeyID(public)
			devices[i] = fanoutDevice{profile: profile, id: id, signing: signing}
			state.Members[profile] = access.Subject{ID: profile, Active: true}
			state.PolicyDevices[id] = access.PolicyDevice{ProfileID: profile, PublicKey: hex.EncodeToString(public)}
			state.KeyRecipients[id] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: hex.EncodeToString(agreement.PublicKey().Bytes())}
		}
	})
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	ownerToken := owner.Token
	preview := func(draft access.PolicyDraft) access.PolicyDraft {
		t.Helper()
		started := time.Now()
		result, err := policy.PreviewPolicyForTransport(ctx, server.protectedSession(ownerToken), draft)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("policy preview revision=%d elapsed=%s bytes=%d", result.Draft.Revision, time.Since(started), len(result.Snapshot))
		return signTestPolicyDraft(t, server, owner, 1, result.Draft)
	}
	commit := func(draft access.PolicyDraft) access.PolicyProof {
		t.Helper()
		started := time.Now()
		proof, err := server.commitProtectedPolicy(ctx, ownerToken, draft)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("policy commit revision=%d elapsed=%s", proof.Draft.Revision, time.Since(started))
		return proof
	}
	anchor := commit(preview(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: fmt.Sprintf("%032x", 1)}))
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("b", 64)
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("c", 64), anchorDigest: anchor.Digest,
		challenges: make(map[string]int64)}
	openSession := func(id string, signing ed25519.PrivateKey) string {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, server.protectedBinding, challenge.Nonce, id)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: id, Nonce: challenge.Nonce,
			Signature: b64.EncodeToString(ed25519.Sign(signing, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session.Token
	}
	ownerToken = openSession(owner.Access.DeviceID, newTestMemberSigner(1).device)
	started := time.Now()
	for i := range devices {
		devices[i].token = openSession(devices[i].id, devices[i].signing)
	}
	t.Logf("KEY-18 setup channels=%d synthetic_device_sessions=%d elapsed=%s", channelCount, deviceCount, time.Since(started))
	trust := map[string]string{"serverId": serverID, "cutoverDigest": runtime.cutoverDigest, "anchorDigest": anchor.Digest,
		"ownerProfileId": owner.Access.EffectiveProfileID, "ownerDeviceId": owner.Access.DeviceID}

	prepare := func(purpose string, selected []string) []fanoutRotation {
		t.Helper()
		type rotationRequest struct {
			Task    access.RotationTask                    `json:"task"`
			Targets map[string]access.EpochPackageDelivery `json:"targets"`
		}
		var requests []rotationRequest
		for _, channel := range selected {
			task, err := server.claimProtectedRotation(ctx, ownerToken, channel, purpose)
			if err != nil {
				t.Fatal(err)
			}
			request := rotationRequest{Task: task, Targets: make(map[string]access.EpochPackageDelivery)}
			for _, target := range task.ArchiveTargets {
				packageDelivery, err := server.loadProtectedRotationTarget(ctx, ownerToken, task.EpochRecord, target)
				if err != nil {
					t.Fatal(err)
				}
				request.Targets[target.KeyID] = packageDelivery
			}
			requests = append(requests, request)
		}
		page, err := policy.PolicyProofPage(ctx, 0)
		if err != nil {
			t.Fatal(err)
		}
		input, err := json.Marshal(map[string]any{"trust": trust, "policy": page, "requests": requests})
		if err != nil {
			t.Fatal(err)
		}
		command := exec.CommandContext(ctx, node, script)
		hideWindow(command)
		command.Stdin = bytes.NewReader(input)
		out, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("Electron rotation: %v\n%s", err, out)
		}
		var result struct {
			Results   []fanoutRotation
			ElapsedMS int
		}
		if err := json.Unmarshal(out, &result); err != nil || len(result.Results) != len(requests) {
			t.Fatalf("rotation fixture returned %d results: %v", len(result.Results), err)
		}
		count := 0
		for i, rotation := range result.Results {
			if rotation.Record.ChannelID != requests[i].Task.ChannelID || len(rotation.Packages) != len(requests[i].Task.Recipients) {
				t.Fatalf("rotation changed recipient scope on %s", rotation.Record.ChannelID)
			}
			count += len(rotation.Packages)
		}
		t.Logf("cryptography purpose=%s channels=%d packages=%d HPKE_bytes=%d fixture_output_bytes=%d seal_and_verify_ms=%d",
			purpose, len(selected), count, count*access.EpochPackageSize, len(out), result.ElapsedMS)
		return result.Results
	}
	apply := func(rotations []fanoutRotation) []string {
		t.Helper()
		start := time.Now()
		var ids []string
		for _, result := range rotations {
			if err := server.commitProtectedEpoch(ctx, ownerToken, result.Record, result.Packages, result.Links...); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, result.Record.KeyID)
		}
		t.Logf("epoch commit purpose=%s channels=%d elapsed=%s", rotations[0].Record.Purpose, len(rotations), time.Since(start))
		return ids
	}
	roleChange := func(op int, group []fanoutDevice, grant bool) access.PolicyDraft {
		t.Helper()
		assignments := make(map[string][]string, len(group))
		for _, device := range group {
			if grant {
				assignments[device.profile] = []string{"reader"}
			} else {
				assignments[device.profile] = nil
			}
		}
		return preview(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", op),
			RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order, Assignments: assignments}})
	}
	old := apply(prepare(access.LiveEpoch, channels))
	commit(roleChange(2, devices, true))
	grantLive := apply(prepare(access.LiveEpoch, channels[:channelCount-1]))
	grantArchive := apply(prepare(access.ArchiveEpoch, channels[:channelCount-1]))
	for i, channel := range channels {
		if i == channelCount-1 {
			if _, err := server.loadProtectedEpochPackage(ctx, devices[0].token, channel, old[i], access.LiveEpoch); !errors.Is(err, access.ErrEpochRecipients) {
				t.Fatalf("unready channel granted a package before its rotation: %v", err)
			}
			continue
		}
		if delivery, err := server.loadProtectedEpochPackage(ctx, devices[0].token, channel, grantLive[i], access.LiveEpoch); err != nil ||
			delivery.Package.RecipientID != devices[0].id {
			t.Fatalf("ready channel failed to give entitled reader its package: %v", err)
		}
	}
	grantLive = append(grantLive, apply(prepare(access.LiveEpoch, channels[channelCount-1:]))...)
	staleArchive := prepare(access.ArchiveEpoch, channels[channelCount-1:])[0]

	appendAs := func(device fanoutDevice, channel, key string, op int) error {
		seed := sha256.Sum256([]byte(fmt.Sprintf("fanout message %s %d", device.id, op)))
		attempt := access.MessageAttempt{ChannelID: channel, KeyID: key, OperationID: fmt.Sprintf("%032x", op),
			Nonce: seed[:12], Ciphertext: seed[:]}
		frame, err := protectedMessageFrame(serverID, access.Principal{ProfileID: device.profile, DeviceID: device.id}, attempt)
		if err != nil {
			return err
		}
		attempt.Signature = ed25519.Sign(device.signing, frame)
		receipt, err := server.appendProtectedMessage(ctx, device.token, attempt)
		if err == nil && (receipt.Existing || receipt.Position == 0) {
			return fmt.Errorf("unexpected accepted receipt: %+v", receipt)
		}
		return err
	}
	if err := appendAs(devices[0], channels[0], grantLive[0], 10); err != nil {
		t.Fatal(err)
	}
	firstRevoke := roleChange(3, devices[:firstRevoked], false)
	const writers = 64
	batch := func(op int, keys []string, actor func(int) int, during func()) []error {
		t.Helper()
		start, group := make(chan struct{}), sync.WaitGroup{}
		errors := make([]error, writers)
		for i := range errors {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				index := i % channelCount
				errors[i] = appendAs(devices[actor(i)], channels[index], keys[index], op+i)
			}()
		}
		started := time.Now()
		close(start)
		if during != nil {
			during()
		}
		group.Wait()
		t.Logf("write batch operation_base=%d concurrent_attempts=%d elapsed=%s", op, writers, time.Since(started))
		return errors
	}
	started = time.Now()
	overlap := batch(100, grantLive, func(i int) int {
		if i < writers/2 {
			return i
		}
		return totalRevoked + i - writers/2
	}, func() { commit(firstRevoke) })
	accepted, denied, revokedAccepted := 0, 0, 0
	for i, result := range overlap {
		if i >= writers/2 && result != nil {
			t.Fatalf("retained writer lost the live epoch during policy commit: %v", result)
		}
		switch {
		case result == nil:
			accepted++
			if i < writers/2 {
				revokedAccepted++
			}
		case errors.Is(result, access.ChannelRestricted):
			denied++
		default:
			t.Fatalf("unexpected concurrent write: %v", result)
		}
	}
	t.Logf("revoke/write overlap accepted=%d accepted_before_revocation=%d denied=%d elapsed=%s",
		accepted, revokedAccepted, denied, time.Since(started))
	if err := server.commitProtectedEpoch(ctx, ownerToken, staleArchive.Record, staleArchive.Packages, staleArchive.Links...); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("old role basis committed an archive candidate: %v", err)
	}
	assertCutoff := func(expected int64) {
		t.Helper()
		current, _, err := policy.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, channel := range channels {
			if current.EpochWindows[channel].CurrentCutoff != expected {
				t.Fatalf("unexpected cutoff on %s: %+v", channel, current.EpochWindows[channel])
			}
		}
	}
	cutoff := server.now().Add(time.Minute).UnixMilli()
	assertCutoff(cutoff)
	millis.Store(20_000)
	commit(roleChange(4, devices[firstRevoked:totalRevoked], false))
	assertCutoff(cutoff)
	for i, channel := range channels[:channelCount-1] {
		actor := devices[0]
		if _, err := server.loadProtectedEpochPackage(ctx, actor.token, channel, grantArchive[i], access.ArchiveEpoch); !errors.Is(err, access.ChannelRestricted) {
			t.Fatalf("revoked device accessed an older archive package: %v", err)
		}
		if _, err := server.loadProtectedArchiveLinks(ctx, actor.token, channel, grantArchive[i]); !errors.Is(err, access.ChannelRestricted) {
			t.Fatalf("revoked device accessed older archive links: %v", err)
		}
	}
	for _, result := range batch(200, grantLive, func(i int) int { return i }, nil) {
		if !errors.Is(result, access.ChannelRestricted) {
			t.Fatalf("revoked writer used grace: %v", result)
		}
	}
	millis.Store(59_999)
	finalRotations := prepare(access.LiveEpoch, channels)
	finalLive := apply(finalRotations)
	finalArchives := prepare(access.ArchiveEpoch, channels)
	apply(finalArchives)
	reading := time.Now()
	for _, rotations := range [][]fanoutRotation{finalRotations, finalArchives} {
		for _, rotation := range rotations {
			want := make(map[string]bool, len(devices[totalRevoked:])+2)
			want[owner.Access.DeviceID] = true
			want[reader.Access.DeviceID] = true
			for _, device := range devices[totalRevoked:] {
				want[device.id] = true
			}
			for i := range devices[:totalRevoked] {
				if _, err := server.loadProtectedEpochPackage(ctx, devices[i].token, rotation.Record.ChannelID, rotation.Record.KeyID, rotation.Record.Purpose); !errors.Is(err, access.ChannelRestricted) {
					t.Fatalf("revoked device %d read a replacement %s package: %v", i, rotation.Record.Purpose, err)
				}
			}
			eligible := devices[totalRevoked]
			if delivery, err := server.loadProtectedEpochPackage(ctx, eligible.token, rotation.Record.ChannelID, rotation.Record.KeyID,
				rotation.Record.Purpose); err != nil || delivery.Package.RecipientID != eligible.id {
				t.Fatalf("retained device missing current %s package: %v", rotation.Record.Purpose, err)
			}
			for _, packet := range rotation.Packages {
				if !want[packet.RecipientID] {
					t.Fatalf("replacement %s manifest leaked an excluded package", rotation.Record.Purpose)
				}
				delete(want, packet.RecipientID)
			}
			if len(want) != 0 {
				t.Fatalf("replacement package set omitted %d entitled devices on %s", len(want), rotation.Record.ChannelID)
			}
		}
	}
	t.Logf("revoked replacement package reads denied=%d elapsed=%s", totalRevoked*channelCount*2, time.Since(reading))
	retained := func(i int) int { return totalRevoked + i%(deviceCount-totalRevoked) }
	for _, result := range batch(300, grantLive, retained, nil) {
		if result != nil {
			t.Fatalf("retained writer lost grace before cutoff: %v", result)
		}
	}
	millis.Store(60_000)
	for _, result := range batch(400, grantLive, retained, nil) {
		if !errors.Is(result, access.ErrEpochStale) {
			t.Fatalf("old generation accepted at cutoff: %v", result)
		}
	}
	for _, result := range batch(500, finalLive, retained, nil) {
		if result != nil {
			t.Fatalf("retained sender cannot use refreshed key: %v", result)
		}
	}
	var acceptedRows int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_messages").Scan(&acceptedRows); err != nil || acceptedRows != 1+accepted+2*writers {
		t.Fatalf("failed writes affected durable messages: %d, %v", acceptedRows, err)
	}
	t.Logf("KEY-18 grace_ms=60000 second_revoke_ms=20000 revoked_after_cutoff=%d durable_messages=%d denied_replacement_reads=%d",
		totalRevoked, acceptedRows, totalRevoked*channelCount*2)
}
