import { deriveKeys, type ExternalE2EEKeyProvider } from 'livekit-client';

const probeBytes = 32;
const timeoutMs = 4_000;
const unverified = () => new Error('UNVERIFIED_PROTECTED_VOICE_WORKER_KEY');

export async function confirmProtectedVoiceWorkerKey(worker: Worker, provider: ExternalE2EEKeyProvider,
  participantIdentity: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !participantIdentity) throw unverified();
  const keys = provider.getKeys();
  const installed = keys[0];
  const options = provider.getOptions();
  if (!installed || keys.length !== 1 || !options.sharedKey || installed.participantIdentity !== undefined) throw unverified();
  const expectedIndex = installed.keyIndex ?? 0;
  const probe = crypto.getRandomValues(new Uint8Array(probeBytes));
  const uuid = crypto.randomUUID();
  try {
    await new Promise<void>((resolve, reject) => {
      let checking = false, settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', fail);
        worker.removeEventListener('messageerror', fail);
        signal?.removeEventListener('abort', fail);
      };
      const fail = () => { if (!settled) { cleanup(); reject(unverified()); } };
      const onMessage = (event: MessageEvent) => {
        const response = event.data;
        if (checking || response?.kind !== 'encryptDataResponse' || response.data?.uuid !== uuid) return;
        checking = true;
        const { payload, iv, keyIndex } = response.data;
        if (!(payload instanceof Uint8Array) || payload.length !== probeBytes + 16 ||
            !(iv instanceof Uint8Array) || iv.length !== 12 || keyIndex !== expectedIndex) { fail(); return; }
        void (async () => {
          const { encryptionKey } = await deriveKeys(installed.key, options);
          const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv) }, encryptionKey,
            Uint8Array.from(payload)));
          try {
            if (clear.length !== probe.length || !clear.every((byte, index) => byte === probe[index]) ||
                provider.getKeys()[0]?.key !== installed.key || signal?.aborted) throw unverified();
          } finally { clear.fill(0); }
          if (!settled) { cleanup(); resolve(); }
        })().catch(fail);
      };
      const timer = setTimeout(fail, timeoutMs);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', fail);
      worker.addEventListener('messageerror', fail);
      signal?.addEventListener('abort', fail);
      try {
        // The SDK awaits setKey and encryptDataRequest in the same worker queue.
        worker.postMessage({ kind: 'encryptDataRequest', data: { uuid, payload: probe, participantIdentity } });
      } catch { fail(); }
    });
  } finally { probe.fill(0); }
}
