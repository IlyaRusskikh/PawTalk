import type { Settings } from './settings';

type SoundSettings = Pick<Settings, 'sounds' | 'outputDevice' | 'outputVolume'> & Partial<Pick<Settings, 'notificationVolume'>>;
export type SoundEvent = 'join' | 'leave' | 'message' | 'mute' | 'unmute' | 'deafen' | 'undeafen';
let context: AudioContext | undefined;
let sink = '';
let previousPurr = 0;
let purrs: number[] = [];
let starts: Promise<unknown> = Promise.resolve();
const current = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();
const fadeSeconds = 0.12;
let idle: ReturnType<typeof setTimeout> | undefined;
const active = new Set<AudioBufferSourceNode>();
const buffers = new Map<string, Promise<AudioBuffer>>();
const roomOffsets = new WeakMap<AudioBuffer, number>();

function roomCueOffset(buffer: AudioBuffer) {
  const cached = roomOffsets.get(buffer);
  if (cached !== undefined) return cached;
  const window = Math.max(1, Math.round(buffer.sampleRate * 0.01));
  let offset = 0;
  // Phone recordings contain a quiet lead-in. Keep 20 ms before the first
  // audible window so room events sound promptly without cutting the attack.
  for (let start = 0; start < buffer.length; start += window) {
    const end = Math.min(buffer.length, start + window);
    let energy = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = start; i < end; i++) energy += samples[i] ** 2;
    }
    if (Math.sqrt(energy / ((end - start) * buffer.numberOfChannels)) >= 0.004) {
      offset = Math.max(0, start / buffer.sampleRate - 0.02); break;
    }
  }
  roomOffsets.set(buffer, offset);
  return offset;
}

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
  if (!settings.sounds || settings.outputVolume <= 0 || volume <= 0) return;
  const file = event === 'message' ? nextPurr() : ['join', 'leave'].includes(event) ? `room-${event}.wav` : `${event}.wav`;
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' });
    const player = context;
    clearTimeout(idle);
    let loading = buffers.get(file);
    if (!loading) {
      loading = fetch(new URL(`./sounds/${file}`, document.baseURI), { signal: AbortSignal.timeout(5000) }).then(async response => {
        if (!response.ok) throw Error('Sound unavailable');
        return player.decodeAudioData(await response.arrayBuffer());
      });
      buffers.set(file, loading);
      void loading.catch(() => buffers.delete(file));
    }
    // Load in parallel, but start in event order, never after a newer cue.
    // The queue waits for startup only, not the duration of a recording.
    const ready = loading;
    const playing = starts.then(async () => {
      const buffer = await ready;
      const output = settings.outputDevice === 'default' ? '' : settings.outputDevice;
      if (sink !== output) { await player.setSinkId(output); sink = output; }
      await player.resume();
      const source = player.createBufferSource();
      const gain = player.createGain();
      source.buffer = buffer;
      const level = Math.max(0, Math.min(2, settings.outputVolume)) * Math.max(0, Math.min(1, volume));
      const channel = event === 'message' ? 'message' : event === 'mute' || event === 'unmute' ? 'microphone' : event === 'deafen' || event === 'undeafen' ? 'playback' : undefined;
      const previous = channel ? current.get(channel) : undefined;
      const now = player.currentTime;
      if (previous) {
        previous.gain.gain.cancelAndHoldAtTime(now);
        previous.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
        previous.source.stop(now + fadeSeconds);
      }
      gain.gain.value = level;
      if (event === 'message') {
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(level, now + 0.008);
      }
      if (channel) current.set(channel, { source, gain });
      source.connect(gain).connect(player.destination);
      active.add(source);
      source.onended = () => {
        active.delete(source); source.disconnect(); gain.disconnect();
        if (channel && current.get(channel)?.source === source) current.delete(channel);
        idle = setTimeout(() => { if (!active.size && player.state === 'running') void player.suspend().catch(() => {}); }, 250);
      };
      source.start(0, event === 'join' || event === 'leave' ? roomCueOffset(buffer) : 0);
      return file;
    });
    starts = playing.catch(() => {});
    return await playing;
  } catch { return undefined; }
}
