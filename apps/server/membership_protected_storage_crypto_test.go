package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The desktop client opens the signed epochs, package, links and surviving
// message that the quota test downloads over TLS.
const protectedStorageClientFixture = `
const assert = require('node:assert/strict');
const { createPrivateKey } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { archiveRevisionPublicKey, sealEpochPackage, openSignedEpochPackage, verifySignedEpoch } = require('./protected-epoch-packages.cjs');
const { packageContext } = require('./protected-archive-session.cjs');
const { openArchiveLinks, sealArchiveLink } = require('./protected-archive-links.cjs');
const { openProtectedText, sealProtectedText } = require('./protected-live-text.cjs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const key = value => Buffer.from(value, 'base64');
const source = record => ({ serverId: input.serverId, channelId: record.ChannelID, generation: record.Generation, keyId: record.KeyID });
const privateKey = (prefix, seed) => createPrivateKey({ key: Buffer.concat([Buffer.from(prefix, 'hex'), seed]), type: 'pkcs8', format: 'der' });
try {
  switch (input.mode) {
    case 'archive': {
      const { task, targets, secrets } = input;
      const secret = key(secrets[task.KeyID]);
      const packages = Object.entries(task.Recipients).map(([id, recipient]) => ({
        RecipientID: id, Purpose: 'archive',
        Ciphertext: sealEpochPackage(secret, packageContext(input.serverId, task, id, recipient.PublicKey)).toString('base64'),
      }));
      const links = targets.map(target => sealArchiveLink(secret, source(task), target, key(secrets[target.KeyID])));
      process.stdout.write(JSON.stringify({ packages, links, wrapKey: archiveRevisionPublicKey(input.serverId, task, secret) }));
      break;
    }
    case 'text': {
      const device = privateKey('302e020100300506032b657004220420', key(input.deviceSeed));
      const sealed = sealProtectedText(key(input.secret), input.serverId, input.author, {
        ChannelID: input.packet.ChannelID, KeyID: input.packet.KeyID, OperationID: input.packet.OperationID,
      }, input.text, device);
      process.stdout.write(JSON.stringify(sealed));
      break;
    }
    case 'open': {
      const { reader, signer, head, history, message } = input;
      const record = head.Epoch.Record;
      const agreement = privateKey('302e020100300506032b656e04220420', Buffer.alloc(32, 22));
      let secret = openSignedEpochPackage(head, packageContext(input.serverId, record, reader.id, reader.key), agreement, signer);
      let expected = record.KeyID;
      for (const { Epoch, Links } of history) {
        assert.equal(Epoch.Record.KeyID, expected);
        verifySignedEpoch(Epoch, packageContext(input.serverId, Epoch.Record), signer);
        const targets = openArchiveLinks(secret, source(Epoch.Record), Links, Epoch.Record.ArchiveLinksDigest);
        secret.fill(0);
        const next = targets.find(target => target.purpose === 'archive' || target.keyId === message.Packet.KeyID);
        assert.ok(next, 'archive traversal lost a predecessor');
        for (const target of targets) if (target !== next) target.secret.fill(0);
        secret = next.secret;
        expected = next.keyId;
      }
      try {
        assert.equal(expected, message.Packet.KeyID);
        assert.equal(openProtectedText(secret, input.serverId, message.Author, message.Packet, signer.key), input.text);
      } finally {
        secret.fill(0);
      }
      process.stdout.write('{}');
      break;
    }
    default: throw new Error('unknown storage fixture operation');
  }
} catch (error) {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
}
`

func runProtectedStorageClient(t *testing.T, node string, request map[string]any, result any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	input, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	jsDirectory, err := filepath.Abs("../client/windows/electron")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, "-e", protectedStorageClientFixture)
	hideWindow(command)
	command.Dir = jsDirectory
	command.Stdin = bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("storage fixture %s: %v\n%s", request["mode"], err, output)
	}
	if err := json.Unmarshal(output, result); err != nil {
		t.Fatalf("storage fixture %s response: %v", request["mode"], err)
	}
}
