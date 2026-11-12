import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serverDefinition } from '../scripts/server-core.mjs';

test('shared-core receipt detects uncommitted source changes and toolchain/version drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-core-receipt-'));
  const write = (name, value) => writeFile(path.join(root, 'server', name), value);
  try {
    await mkdir(path.join(root, 'server'));
    await write('VERSION', '0.10.1\n');
    await write('standalone.Dockerfile', 'FROM golang:1.27.3-alpine AS build\nFROM livekit/livekit-server:v1.13.11 AS media\n');
    await write('go.mod', 'module example/core\ngo 1.27.0\n');
    await write('main.go', 'package main\nfunc main() {}\n');
    const first = await serverDefinition(root);
    assert.equal(first.version, '0.10.1');
    await write('standalone.Dockerfile', 'FROM golang:1.27.3-alpine AS build\r\nFROM livekit/livekit-server:v1.13.11 AS media\r\n');
    assert.equal((await serverDefinition(root)).goVersion, first.goVersion, 'Windows CRLF definitions resolve the same toolchain');
    await write('standalone.Dockerfile', 'FROM golang:1.27.3-alpine AS build\nFROM livekit/livekit-server:v1.13.11 AS media\n');
    await write('build.exe', 'ignored generated binary');
    assert.deepEqual(await serverDefinition(root), first);
    await write('main.go', 'package main\nfunc main() { println("changed") }\n');
    assert.notEqual((await serverDefinition(root)).sourceSha256, first.sourceSha256);
    await write('VERSION', '0.11.0\n');
    assert.equal((await serverDefinition(root)).version, '0.11.0');
    await write('standalone.Dockerfile', 'FROM golang:latest AS build\n');
    await assert.rejects(serverDefinition(root), /Invalid shared Server/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
