import { createRoot } from 'react-dom/client';
import { ServerChat } from '../src/ServerChat';
import type { Channel, Message, ServerState } from '../src/membership';
import { generateVideo, transcodeVideo } from './media-scroll-video';
import '../src/style.css';
import '../src/interface.css';
import '../src/membership.css';

type Mode = 'text' | 'current' | 'preview' | 'three';
type Case = { mode: Mode; count: number; pixels: number; quality: number; mbps: number; videoSeconds?: number };
type Asset = { blob: Blob; data: string };

function canvas(width: number, height: number) {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

async function encode(source: HTMLCanvasElement, width: number, mime: string, quality: number): Promise<Asset> {
  const target = canvas(width, Math.round(width * source.height / source.width));
  target.getContext('2d')!.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise<Blob>((resolve, reject) => target.toBlob(
    value => value && value.type === mime ? resolve(value) : reject(Error('Encoder unavailable: ' + mime)), mime, quality,
  ));
  target.width = target.height = 0;
  return { blob, data: await dataURL(blob) };
}

function dataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function sourceImage(width: number) {
  const source = canvas(width, width * 3 / 4);
  const context = source.getContext('2d')!;
  const image = context.createImageData(source.width, source.height);
  let random = 59173;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const noise = (random >>> 27) - 16;
      const i = (y * source.width + x) * 4;
      image.data[i] = 128 + 90 * Math.sin(x / 37) + noise;
      image.data[i + 1] = 128 + 80 * Math.sin(y / 62) + noise;
      image.data[i + 2] = 128 + 85 * Math.cos((x + y) / 53) + noise;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return source;
}

async function videoFixture({ pixels, videoSeconds }: Case) {
  if (!videoSeconds) throw Error('Missing duration');
  const source = sourceImage(pixels);
  try {
    return await dataURL(await generateVideo(source, 8_000_000, videoSeconds));
  } finally {
    source.width = source.height = 0;
  }
}

async function fixtures({ pixels: width, quality, mode, videoSeconds }: Case, videoInput?: string) {
  if (mode === 'text') return undefined;
  const source = sourceImage(width);
  if (videoSeconds && !videoInput) throw Error('Missing frozen video fixture');
  const original = videoSeconds
    ? { blob: await (await fetch(videoInput!)).blob(), data: '' }
    : await encode(source, width, 'image/jpeg', quality);
  const start = performance.now();
  const preview = mode === 'current'
    ? videoSeconds ? await encode(source, Math.min(640, width), 'image/jpeg', 0.82) : original
    : await encode(source, Math.min(480, width), 'image/webp', 0.75);
  const previewMs = performance.now() - start;
  const optimizedStart = performance.now();
  let candidate = original;
  if (mode === 'three') {
    candidate = videoSeconds
      ? { blob: await transcodeVideo(original.blob, 960, videoSeconds), data: '' }
      : await encode(source, Math.min(2048, width), 'image/webp', 0.82);
  }
  const optimizedMs = performance.now() - optimizedStart;
  const viewer = candidate.blob.size < original.blob.size ? candidate : original;
  source.width = source.height = 0;
  return { original, preview, viewer, candidate, previewMs, optimizedMs };
}

const channel: Channel = { id: 'general', name: 'General', kind: 'text', protected: false, position: 0,
  revision: 1, messageRevision: 1, lastMessageId: 72 };
const state: ServerState = {
  serverId: 'benchmark', name: 'Benchmark', revision: 1, controlRevision: 1, eventsLive: true,
  self: { effectiveProfileId: 'me', profileId: 'me', deviceId: 'test', role: 'member', permissions: [] },
  channels: [channel], profiles: [{ id: 'me', nickname: 'Me', revision: 1 }], members: [],
  devices: [], bindings: [], voice: [],
};

async function run(config: Case, videoInput?: string) {
  if (config.count > channel.lastMessageId) throw Error('Too many attachments for the fixture history');
  const assets = await fixtures(config, videoInput);
  const rows: Message[] = Array.from({ length: channel.lastMessageId }, (_, index) => {
    const id = index + 1;
    const files = assets && Math.floor(id * config.count / channel.lastMessageId) >
      Math.floor(index * config.count / channel.lastMessageId) ? [{
        id: 'file-' + id, name: config.videoSeconds ? 'Clip ' + id + '.webm' : 'Photo ' + id + '.jpg',
        mime: assets.original.blob.type, size: assets.original.blob.size,
        ...(config.mode === 'current' || config.videoSeconds
          ? { poster: { id: 'preview-' + id, mime: assets.preview.blob.type } }
          : { preview: { id: 'preview-' + id, mime: 'image/webp' as const, size: assets.preview.blob.size } }),
        ...(config.mode === 'three' && !config.videoSeconds && assets.viewer !== assets.original && {
          view: { id: 'view-' + id, mime: 'image/webp' as const, size: assets.viewer.blob.size },
        }),
      }] : undefined;
    return { id, requestId: 'request-' + id, channelId: channel.id, authorProfileId: 'me',
      sentAt: 1760000000000 + id * 180000, content: { text: 'Benchmark message ' + id, files } };
  });
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const networkDelay = (bytes: number) => 20 + bytes * 8 / (config.mbps * 1000);
  const requests = { count: 0, bytes: 0, pending: 0, peak: 0, viewerBytes: 0 };
  const uniquePreviews = new Set<string>();
  const errors: string[] = [];
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    membership: async (action: string, input: { attachmentId: string }) => {
      if (action === 'messages') return { value: { messages: structuredClone(rows), first: 1,
        last: rows.length, hasOlder: false, hasNewer: false, unread: 0, revision: 1 } };
      if (action === 'memory.status') return { value: { low: false } };
      if (action !== 'image' && action !== 'file') return { value: true };
      if (!assets) throw Error('Unexpected media request');
      if (input.attachmentId.startsWith('preview-')) {
        const asset = assets.preview;
        uniquePreviews.add(input.attachmentId);
        requests.count++;
        requests.bytes += asset.blob.size;
        requests.peak = Math.max(requests.peak, ++requests.pending);
        await wait(networkDelay(asset.blob.size));
        requests.pending--;
        if (action === 'image') {
          // Unique URLs prevent a shared decoded image from understating memory and decode work.
          return { value: asset.data.replace(';base64', ';id=' + input.attachmentId + ';base64') };
        }
        return { value: new Uint8Array(await asset.blob.arrayBuffer()) };
      }
      const asset = config.videoSeconds || input.attachmentId.startsWith('view-') ? assets.viewer : assets.original;
      requests.viewerBytes += asset.blob.size;
      await wait(networkDelay(asset.blob.size));
      return { value: new Uint8Array(await asset.blob.arrayBuffer()) };
    },
  } });
  localStorage.setItem('pawtalk.chat.window', '100');
  localStorage.removeItem('pawtalk.v2.position.benchmark:general');
  const container = document.getElementById('root')!;
  container.style.cssText = 'height:100vh;width:680px';
  createRoot(container).render(<ServerChat state={state} channel={channel} focused={false}
    onRead={() => {}} onError={error => errors.push(error)} />);
  async function until(check: () => boolean, label: string, timeout = 5000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (check()) return;
      await wait(10);
    }
    throw Error('Benchmark timed out waiting for ' + label + ': ' + errors.join(', '));
  }
  await until(() => document.querySelectorAll('.member-message').length === rows.length, 'chat history');
  const pane = document.querySelector<HTMLElement>('.chat-stream')!;
  const max = pane.scrollHeight - pane.clientHeight;
  if (max <= 0) throw Error('Chat has no scroll range');
  const frameTimes: number[] = [];
  await new Promise<void>(resolve => {
    let start = 0;
    let last = 0;
    const step = (now: number) => {
      if (!start) start = now;
      if (last) frameTimes.push(now - last);
      last = now;
      const progress = Math.min(2, (now - start) / 2500);
      pane.scrollTop = max * Math.abs(1 - progress);
      if (progress < 2) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  await until(() => requests.pending === 0 && [...document.querySelectorAll<HTMLImageElement>('.video-poster img')]
    .every(image => image.complete && image.naturalWidth > 0), 'visible previews', 15000);
  if (assets && (!uniquePreviews.size || !document.querySelector('.video-poster img'))) throw Error('Scroll missed attachments');
  const sorted = [...frameTimes].sort((a, b) => a - b);
  let openMs: number | undefined;
  if (assets) {
    const open = document.querySelector<HTMLButtonElement>('.chat-video-open')!;
    const started = performance.now();
    open.click();
    await until(() => {
      if (config.videoSeconds) {
        const video = document.querySelector<HTMLVideoElement>('.video-stage video');
        return !!video && !video.paused && video.currentTime > 0;
      }
      return [...document.querySelectorAll<HTMLImageElement>('.photo-viewer-image')]
        .some(image => image.complete && image.naturalWidth > 0);
    }, 'media viewer', 15000);
    openMs = performance.now() - started;
  }
  if (errors.length) throw Error(errors.join(', '));
  return {
    ...config, scrollPixels: max, frames: sorted.length, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1], maxMs: sorted.at(-1),
    framesOver25Ms: sorted.filter(time => time > 25).length,
    frameTimes, requests, uniquePreviews: uniquePreviews.size, openMs,
    ...(assets && { originalBytes: assets.original.blob.size, previewBytes: assets.preview.blob.size,
      optimizedCandidateBytes: assets.candidate.blob.size, previewMs: assets.previewMs, optimizedMs: assets.optimizedMs }),
  };
}

Object.assign(window, { runMediaScroll: run, makeMediaScrollVideo: videoFixture });
