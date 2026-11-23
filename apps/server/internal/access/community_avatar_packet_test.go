package access

import (
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCommunityAvatarPacketClientInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	module, err := filepath.Abs("../../../client/windows/electron/protected-community-avatar.cjs")
	if err != nil {
		t.Fatal(err)
	}
	const fixture = `
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { sealCommunityAvatar, openCommunityAvatar, rewrapCommunityAvatar } = require(process.argv[1]);
const author = generateKeyPairSync('ed25519');
const raw = publicKey => publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const signer = raw(author.publicKey).toString('hex');
const recipient = id => {
  const keys = generateKeyPairSync('x25519');
  return { privateKey: keys.privateKey, descriptor: { id: id.repeat(64), publicKey: raw(keys.publicKey).toString('hex') } };
};
const member = recipient('1'), later = recipient('2'), stranger = recipient('3'), linked = recipient('4');
const context = { serverId: '4'.repeat(32), revision: 2, operationId: '5'.repeat(32), policyHead: '6'.repeat(64),
  profileId: '7'.repeat(64), deviceId: createHash('sha256').update(raw(author.publicKey)).digest('hex') };
const image = Buffer.from('encrypted community avatar fixture');
const { packet, packages } = sealCommunityAvatar(context, image, [linked.descriptor, member.descriptor], author.privateKey);
const open = (recipient, key, body = packet, binding = context) =>
  openCommunityAvatar(binding, body, key, recipient.descriptor, recipient.privateKey, signer);
assert.deepEqual(open(member, packages[0]), image);
assert.deepEqual(open(linked, packages[1]), image);
assert.throws(() => sealCommunityAvatar(context, image, [member.descriptor, member.descriptor], author.privateKey),
  { code: 'INVALID_PROTECTED_AVATAR' });
assert.throws(() => open(stranger, { ...packages[0], id: stranger.descriptor.id }), { code: 'INVALID_PROTECTED_AVATAR' });
assert.throws(() => open(member, packages[0], packet, { ...context, revision: 3 }), { code: 'INVALID_PROTECTED_AVATAR' });
assert.throws(() => open(member, packages[0], { ...packet, ciphertext: Buffer.alloc(17).toString('base64') }),
  { code: 'INVALID_PROTECTED_AVATAR' });
const room = rewrapCommunityAvatar(context, packet, packages[0], member.descriptor, member.privateKey, signer, later.descriptor);
assert.deepEqual(open(later, room), image);
assert.throws(() => open(stranger, { ...room, id: stranger.descriptor.id }), { code: 'INVALID_PROTECTED_AVATAR' });
process.stdout.write(JSON.stringify({ context, packet, signer }));`
	output, err := exec.CommandContext(t.Context(), node, "-e", fixture, module).CombinedOutput()
	if err != nil {
		t.Fatalf("avatar Client fixture: %v\n%s", err, output)
	}
	var vector struct {
		Context CommunityAvatarContext
		Packet  CommunityAvatarPacket
		Signer  string
	}
	if err := json.Unmarshal(output, &vector); err != nil {
		t.Fatal(err)
	}
	if err := vector.Packet.Verify(vector.Context, vector.Signer); err != nil {
		t.Fatalf("Server rejected the Client signature: %v", err)
	}
	changed := vector.Context
	changed.Revision++
	if err := vector.Packet.Verify(changed, vector.Signer); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("Server accepted the signature at another revision: %v", err)
	}
	vector.Packet.Ciphertext[0] ^= 1
	if err := vector.Packet.Verify(vector.Context, vector.Signer); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("Server accepted changed ciphertext: %v", err)
	}
}
