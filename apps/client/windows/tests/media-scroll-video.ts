const webm = 'video/webm;codecs=vp8';

async function record(canvas: HTMLCanvasElement, bitsPerSecond: number, duration: number, update: (time: number) => void) {
  if (!MediaRecorder.isTypeSupported(webm)) throw Error('VP8 recording unavailable');
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: webm, videoBitsPerSecond: bitsPerSecond });
  const parts: Blob[] = [];
  const result = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = event => parts.push(event.data);
    recorder.onstop = () => resolve(new Blob(parts, { type: 'video/webm' }));
    recorder.onerror = reject;
  });
  update(0);
  recorder.start();
  try {
    await new Promise<void>(resolve => {
      const start = performance.now();
      const frame = (now: number) => {
        const seconds = (now - start) / 1000;
        update(seconds);
        if (seconds < duration) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    recorder.stop();
    return await result;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

export async function generateVideo(source: HTMLCanvasElement, bitsPerSecond: number, duration: number) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d')!;
  return record(canvas, bitsPerSecond, duration, time => {
    const offset = Math.floor(time * source.width / 3);
    context.drawImage(source, offset, 0);
    context.drawImage(source, offset - source.width, 0);
  });
}

export async function transcodeVideo(original: Blob, width: number, duration: number) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(original);
  video.muted = true;
  video.src = url;
  try {
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(video.videoWidth, width);
    canvas.height = Math.floor(canvas.width * video.videoHeight / video.videoWidth);
    const context = canvas.getContext('2d')!;
    return await record(canvas, 1_500_000, duration, () => context.drawImage(video, 0, 0, canvas.width, canvas.height));
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
