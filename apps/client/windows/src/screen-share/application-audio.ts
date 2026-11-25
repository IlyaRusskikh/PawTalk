import worklet from './application-audio-worklet.js?worker&url';

export async function attachApplicationAudio(stream: MediaStream) {
  const read = window.desktop?.readApplicationAudio;
  const video = stream.getVideoTracks()[0];
  if (!read || !video) throw new Error('APPLICATION_AUDIO_UNAVAILABLE');
  const context = new AudioContext({ sampleRate: 44100 });
  let end!: () => void;
  const audioEnded = new Promise<void>(resolve => { end = resolve; });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let audio: MediaStreamTrack | undefined;
  function dispose() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    audio?.stop();
    void context.close().catch(() => {});
  }

  try {
    const deadline = performance.now() + 4000;
    let first = await read();
    while (first === undefined && performance.now() < deadline && video.readyState === 'live') {
      await new Promise(resolve => setTimeout(resolve, 25));
      first = await read();
    }
    if (!first || video.readyState !== 'live') throw new Error('APPLICATION_AUDIO_UNAVAILABLE');
    await context.audioWorklet.addModule(worklet);
    const node = new AudioWorkletNode(context, 'pawtalk-application-audio', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    const destination = context.createMediaStreamDestination();
    // Publish from a stream destination only. The local speakers are never connected.
    node.connect(destination);
    await context.resume();
    audio = destination.stream.getAudioTracks()[0];
    audio.contentHint = 'music';
    stream.addTrack(audio);

    function post(bytes: Uint8Array<ArrayBuffer>) {
      if (bytes.byteLength && bytes.byteLength % 4 === 0) {
        node.port.postMessage(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2), [bytes.buffer]);
      }
    }
    async function pump() {
      try {
        const bytes = await read!();
        if (stopped) return;
        if (bytes === null) throw new Error('APPLICATION_AUDIO_ENDED');
        if (bytes) post(bytes);
        timer = setTimeout(() => void pump(), 15);
      } catch {
        if (stopped) return;
        dispose();
        end();
      }
    }
    post(first);
    void pump();
    return { stream, dispose, audioEnded };
  } catch (error) {
    dispose();
    throw error;
  }
}
