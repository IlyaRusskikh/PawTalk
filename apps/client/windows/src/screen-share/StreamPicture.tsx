import { useEffect, useRef, useState } from 'react';
import type { Track } from 'livekit-client';
import { useLanguage } from '../i18n';
import type { ScreenStream } from '../session';
import { BlindfoldCat, PawSpinner } from './StreamStatus';

const copy = {
  ru: { loading: 'Загрузка стрима…', minimized: 'Автор свернул приложение' },
  en: { loading: 'Loading stream…', minimized: 'The presenter minimized the application' },
};

export function StreamPicture({ stream, className, alt }: { stream: ScreenStream; className?: string; alt: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playingTrack, setPlayingTrack] = useState<Track>();
  const track = stream.track;
  const labels = copy[useLanguage()];
  useEffect(() => {
    const element = video.current;
    if (!track || !element) return;
    const ready = () => setPlayingTrack(track);
    element.addEventListener('loadeddata', ready, { once: true });
    track.attach(element);
    const callback = element.requestVideoFrameCallback(ready);
    return () => {
      element.removeEventListener('loadeddata', ready);
      element.cancelVideoFrameCallback(callback);
      track.detach(element);
    };
  }, [track]);
  const status = stream.minimized ? 'minimized' : !track || playingTrack !== track ? 'loading' : undefined;
  return <span className={`stream-picture-content ${className ?? ''}`} data-stream-status={status}>
    {track && <video ref={video} autoPlay muted playsInline aria-label={alt || undefined}/>}
    {status && <span className="stream-picture-status" role="status">
      {status === 'minimized' ? <BlindfoldCat/> : <PawSpinner/>}{labels[status]}
    </span>}
  </span>;
}
