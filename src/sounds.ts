import type { Settings } from './settings';

type SoundSettings = Pick<Settings, 'sounds' | 'outputDevice' | 'outputVolume'> & Partial<Pick<Settings, 'notificationVolume'>>;
export type SoundEvent = 'join' | 'leave' | 'message';
let context: AudioContext | undefined;
let sink = '';
let lastMessage = -Infinity;
let previousPurr = 0;
let purrs: number[] = [];
let route = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;
const active = new Set<AudioBufferSourceNode>();
const buffers = new Map<string, Promise<AudioBuffer>>();

function nextPurr() {
  if (!purrs.length) {
    purrs = [1, 2, 3, 4, 5];
    for (let i = purrs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [purrs[i], purrs[j]] = [purrs[j], purrs[i]];
    }
    if (purrs.at(-1) === previousPurr) [purrs[0], purrs[4]] = [purrs[4], purrs[0]];
  }
  previousPurr = purrs.pop()!;
  return `message-purr-0${previousPurr}.wav`;
}

// One reusable context, routed to the same output device as the voice session.
// A failed device/download never interrupts chat or a voice connection.
export async function playSound(event: SoundEvent, settings: SoundSettings): Promise<string | undefined> {
  const volume = settings.notificationVolume ?? 1;
  if (!settings.sounds || settings.outputVolume <= 0 || volume <= 0 || active.size >= 4) return;
  const now = performance.now();
  if (event === 'message') {
    if (now - lastMessage < 1500) return;
    lastMessage = now;
  }
  const file = event === 'message' ? nextPurr() : `room-${event}.wav`;
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' });
    const player = context;
    clearTimeout(idle);
    let loading = buffers.get(file);
    if (!loading) {
      loading = fetch(new URL(`./sounds/${file}`, document.baseURI)).then(async response => {
        if (!response.ok) throw Error('Sound unavailable');
        return player.decodeAudioData(await response.arrayBuffer());
      });
      buffers.set(file, loading);
      void loading.catch(() => buffers.delete(file));
    }
    const buffer = await loading;
    // Device changes are serialized so simultaneous cues cannot race a sink switch.
    const output = settings.outputDevice === 'default' ? '' : settings.outputDevice;
    const routed = route.catch(() => {}).then(async () => {
      if (sink !== output) { await player.setSinkId(output); sink = output; }
    });
    route = routed;
    await routed;
    await player.resume();
    const source = player.createBufferSource();
    const gain = player.createGain();
    source.buffer = buffer;
    gain.gain.value = Math.max(0, Math.min(2, settings.outputVolume)) * Math.max(0, Math.min(1, volume));
    source.connect(gain).connect(player.destination);
    active.add(source);
    source.onended = () => {
      active.delete(source); source.disconnect(); gain.disconnect();
      idle = setTimeout(() => { if (!active.size && player.state === 'running') void player.suspend().catch(() => {}); }, 250);
    };
    source.start();
    return file;
  } catch { return undefined; }
}
