import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { ExternalE2EEKeyProvider } from 'livekit-client';
import { confirmProtectedVoiceWorkerKey } from '../src/protectedVoiceWorker.ts';

const unverified = { message: 'UNVERIFIED_PROTECTED_VOICE_WORKER_KEY' };
const participantIdentity = 'synthetic-voice-participant';
const material = () => crypto.getRandomValues(new Uint8Array(32)).buffer;

function liveKitWorker() {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = globalThis;
    globalThis.onmessage = null;
    globalThis.postMessage = message => parentPort.postMessage(message);
    import(workerData).then(() => parentPort.on('message', data => onmessage({ data })));
  `, { eval: true, workerData: import.meta.resolve('livekit-client/e2ee-worker') });
  const events = new EventTarget();
  worker.on('message', data => events.dispatchEvent(new MessageEvent('message', { data })));
  worker.on('messageerror', data => events.dispatchEvent(new MessageEvent('messageerror', { data })));
  worker.on('error', () => events.dispatchEvent(new Event('error')));
  return {
    postMessage: data => worker.postMessage(data),
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    terminate: () => worker.terminate(),
  };
}

test('actual installed SDK worker proves the queued shared key and rejects a stale worker key', async t => {
  const worker = liveKitWorker(), provider = new ExternalE2EEKeyProvider();
  t.after(() => worker.terminate());
  const accept = () => confirmProtectedVoiceWorkerKey(worker, provider, participantIdentity);
  const install = () => worker.postMessage({ kind: 'setKey', data: { key: provider.getKeys()[0].key, keyIndex: 0,
    updateCurrentKeyIndex: true } });
  worker.postMessage({ kind: 'init', data: { keyProviderOptions: provider.getOptions(), loglevel: 'silent' } });
  await provider.setKey(material());
  install();
  await accept();

  await provider.setKey(material());
  await assert.rejects(accept(), unverified);
  install();
  await accept();
});

class SilentWorker extends EventTarget {
  activeListeners = 0;
  probe;
  postMessage(request) { this.probe = request.data; }
  addEventListener(...args) { this.activeListeners++; super.addEventListener(...args); }
  removeEventListener(...args) { this.activeListeners--; super.removeEventListener(...args); }
  respond(data) { this.dispatchEvent(new MessageEvent('message', { data: { kind: 'encryptDataResponse', data } })); }
}

test('probe ignores unrelated messages, then aborts and wipes the request buffer', async () => {
  const worker = new SilentWorker(), provider = new ExternalE2EEKeyProvider(), abort = new AbortController();
  await provider.setKey(material());
  const pending = confirmProtectedVoiceWorkerKey(worker, provider, participantIdentity, abort.signal);
  assert.equal(worker.activeListeners, 3);
  worker.respond({ uuid: crypto.randomUUID() });
  assert.equal(worker.activeListeners, 3);
  abort.abort();
  await assert.rejects(pending, unverified);
  assert.equal(worker.activeListeners, 0);
  assert.equal(worker.probe.payload.every(byte => byte === 0), true);
});

test('matching malformed response and bounded silence fail with no probe data in the error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new SilentWorker(), provider = new ExternalE2EEKeyProvider();
  await provider.setKey(material());
  const pending = confirmProtectedVoiceWorkerKey(worker, provider, participantIdentity);
  worker.respond({ uuid: worker.probe.uuid, payload: new Uint8Array(32), iv: new Uint8Array(12), keyIndex: 0 });
  await assert.rejects(pending, unverified);

  const silent = confirmProtectedVoiceWorkerKey(worker, provider, participantIdentity);
  t.mock.timers.tick(4_000);
  await assert.rejects(silent, unverified);
  assert.equal(worker.probe.payload.every(byte => byte === 0), true);
});
