import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { Avatar } from '../Avatar';
import { Icon } from '../Controls';
import { Participants } from '../Participants';
import type { ScreenStream, Snapshot, VoiceSession } from '../session';
import { t, useLanguage } from '../i18n';
import { ScreenShareControls } from './ScreenShareControls';
import { StreamPicture } from './StreamPicture';
import { useStreamPreviewMotion } from './screen-share-motion';
import './screen-share.css';

export const streamCallCopy = {
  ru: {
    streams: 'Стримы',
    open: 'Открыть стрим в фокусе', overview: 'Вернуться к обзору',
    volume: 'Громкость стрима',
    mute: 'Выключить звук стрима', unmute: 'Включить звук стрима',
    chatLayout: { hide: 'Скрыть чат', restore: 'Развернуть чат', bottom: 'Перенести чат вниз', right: 'Перенести чат вправо' },
    call: 'Голосовой звонок',
    full: 'На весь экран', exitFull: 'Выйти из полноэкранного режима', fullscreenError: 'Не удалось открыть полноэкранный просмотр.',
  },
  en: {
    streams: 'Streams',
    open: 'Focus stream', overview: 'Return to overview',
    volume: 'Stream volume',
    mute: 'Mute stream', unmute: 'Unmute stream',
    chatLayout: { hide: 'Hide chat', restore: 'Show chat', bottom: 'Move chat down', right: 'Move chat right' },
    call: 'Voice call',
    full: 'Full screen', exitFull: 'Exit full screen', fullscreenError: 'Could not open the full-screen view.',
  },
};

type Stream = ScreenStream & { name: string; avatar?: string };
const fullscreenControlsDelay = 2000;
const fullscreenRecoveryDelay = 6000;
const defaultStreamAudio = { volume: 1, muted: false };

export default function CallScreenView({ audioControls, deafened, onLeave, participantProps, live }: {
  audioControls: ReactNode; deafened: boolean; onLeave(): void;
  participantProps: ComponentProps<typeof Participants>;
  live: { session: VoiceSession; snapshot: Snapshot };
}) {
  const language = useLanguage();
  const labels = streamCallCopy[language];
  const [focusOrder, setFocusOrder] = useState<string[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenStream, setFullscreenStream] = useState<Stream>();
  const [fullscreenControls, setFullscreenControls] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [streamAudio, setStreamAudio] = useState<Record<string, typeof defaultStreamAudio>>({});
  const focusFrame = useRef<HTMLDivElement>(null);
  const fullscreenIdle = useRef<number>(undefined);
  const { people } = participantProps;
  const peopleById = new Map(people.map(person => [person.id, person]));
  const streams: Stream[] = (live.snapshot.screens ?? []).map(screen => ({
    ...screen, name: peopleById.get(screen.id)?.name ?? t('Участник'), avatar: peopleById.get(screen.id)?.avatar,
  }));

  const streamsById = new Map(streams.map(stream => [stream.id, stream]));
  const single = streams.length === 1;
  const fullscreenSource = fullscreenStream && streamsById.get(fullscreenStream.id);
  const fullscreenEnded = !!fullscreenStream && live.snapshot.endedScreens?.has(fullscreenStream.id) === true;
  const focused = fullscreenStream ? fullscreenSource ?? fullscreenStream : single ? streams[0] : streamsById.get(focusOrder[0]);
  const focusedAudio = (focused && streamAudio[focused.id]) ?? defaultStreamAudio;
  const volume = focusedAudio.muted || deafened ? 0 : focusedAudio.volume;
  const session = live.session;
  const focusedId = focused?.id;
  const listeningId = focused && !focused.local && focused.hasAudio ? focused.id : undefined;
  useLayoutEffect(() => { session.setScreenListening(listeningId, volume); }, [session, listeningId, volume]);
  useLayoutEffect(() => () => { session.setScreenListening(undefined, 0); }, [session]);
  const thumbnails = [
    ...focusOrder.filter(id => id !== focusedId).flatMap(id => streamsById.get(id) ?? []),
    ...streams.filter(stream => stream.id !== focusedId && !focusOrder.includes(stream.id)),
  ];
  const motion = useStreamPreviewMotion(people.map(person => person.id), streams.length > 0,
    fullscreen ? undefined : JSON.stringify([focusedId, streams.map(stream => stream.id), people.map(person => person.id)]));
  const columns = Math.max(1, Math.ceil(Math.sqrt(streams.length)));
  const rows = Math.ceil(streams.length / columns);
  const gridRows = Array.from({ length: rows }, (_, index) => streams.slice(index * columns, (index + 1) * columns));
  const participants = <Participants {...participantProps} compact={streams.length > 0} streaming={new Set(streamsById.keys())}/>;

  useEffect(() => {
    const sync = () => {
      const active = !!focusFrame.current && document.fullscreenElement === focusFrame.current;
      setFullscreen(active);
      if (active) revealFullscreenControls();
      else {
        setFullscreenStream(undefined);
        window.clearTimeout(fullscreenIdle.current);
        setFullscreenControls(false);
      }
    };
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      window.clearTimeout(fullscreenIdle.current);
    };
  }, []);

  useEffect(() => {
    if (!fullscreen || fullscreenSource && !fullscreenEnded) return;
    const exit = () => {
      if (focusFrame.current && document.fullscreenElement === focusFrame.current) {
        void document.exitFullscreen().catch(() => {});
      }
    };
    if (fullscreenEnded) { exit(); return; }
    const timer = window.setTimeout(exit, fullscreenRecoveryDelay);
    return () => window.clearTimeout(timer);
  }, [fullscreen, !!fullscreenSource, fullscreenEnded]);

  function revealFullscreenControls() {
    setFullscreenControls(true);
    window.clearTimeout(fullscreenIdle.current);
    fullscreenIdle.current = window.setTimeout(() => setFullscreenControls(false), fullscreenControlsDelay);
  }

  function selectStream(id: string) {
    motion.capture();
    setFullscreenError(false);
    if (!focused) {
      setFocusOrder([id, ...streams.filter(stream => stream.id !== id).map(stream => stream.id)]);
    } else if (focused.id === id) {
      setFocusOrder([]);
    } else {
      setFocusOrder([id, ...thumbnails.map(stream => stream.id === id ? focused.id : stream.id)]);
    }
  }

  async function toggleFullscreen() {
    const frame = focusFrame.current;
    if (!frame || !focused) return;
    try {
      if (document.fullscreenElement === frame) await document.exitFullscreen();
      else {
        // Keep the same fullscreen element and author during a temporary loss of the publication.
        setFullscreenStream({ id: focused.id, name: focused.name, avatar: focused.avatar, local: focused.local, hasAudio: false });
        await frame.requestFullscreen();
      }
    } catch {
      if (document.fullscreenElement !== frame) setFullscreenStream(undefined);
      setFullscreenError(true);
    }
  }

  function streamVolume(stream: Stream) {
    const { volume, muted } = streamAudio[stream.id] ?? defaultStreamAudio;
    const percent = Math.round(volume * 100) + '%';
    const label = labels.volume + ' · ' + stream.name;
    const toggleLabel = muted ? labels.unmute : labels.mute;
    return <div className="dev-stream-volume-control">
      <button type="button" className="icon-button dev-stream-volume-button" aria-pressed={muted}
        aria-label={toggleLabel + ' · ' + stream.name} title={toggleLabel}
        onClick={() => setStreamAudio(previous => {
          const current = previous[stream.id] ?? defaultStreamAudio;
          return { ...previous, [stream.id]: { ...current, muted: !current.muted } };
        })}>
        <Icon name={muted || volume === 0 ? 'sound-off' : 'sound'} size={14}/>
      </button>
      <label className="voice-volume-popover dev-stream-volume">
        <output>{percent}</output>
        <input aria-label={label} aria-valuetext={percent} type="range" min={0} max={2}
          step={0.01} value={volume} disabled={muted} onChange={event => {
            const value = Number(event.currentTarget.value);
            setStreamAudio(previous => {
              const current = previous[stream.id] ?? defaultStreamAudio;
              return current.muted ? previous : { ...previous, [stream.id]: { ...current, volume: value } };
            });
          }}/>
      </label>
    </div>;
  }

  function streamAuthor(stream: Stream) {
    return <span className="dev-stream-author" aria-hidden="true">
      <Avatar name={stream.name} image={stream.avatar}/>
      <span className="dev-stream-author-details">{stream.name}</span>
    </span>;
  }

  function tile(stream: Stream, main = false) {
    const picture = <StreamPicture stream={stream} alt={single ? stream.name : ''}/>;
    return <div className="dev-stream-tile" data-tile={stream.id}>
      {single ? <div className="dev-stream-picture" data-stream={stream.id}>{picture}</div>
        : <button type="button" className="dev-stream-picture" data-stream={stream.id}
          aria-label={(main ? labels.overview : labels.open) + ' · ' + stream.name} onClick={() => selectStream(stream.id)}>
          {picture}
        </button>}
      {streamAuthor(stream)}
      {main && stream.id === listeningId && streamVolume(stream)}
    </div>;
  }

  return <section ref={motion.scope} className="dev-stream-call" aria-label={labels.call}
    data-voice-only={streams.length === 0 || undefined}>
    {streams.length === 0 && !focused ? <div className="room-participants" aria-label={t('Участники')}>
      {participants}
    </div> :
    <div className="dev-stream-stage" aria-label={labels.streams}>
      {focused ? <div className="dev-stream-focus">
        <div ref={focusFrame} className="dev-stream-main-tile" data-controls-visible={fullscreenControls || undefined}
          onPointerMove={fullscreen ? revealFullscreenControls : undefined}
          onFocus={fullscreen ? revealFullscreenControls : undefined}
          onKeyDown={fullscreen ? revealFullscreenControls : undefined}>
          {fullscreen ? <><StreamPicture className="dev-stream-full-image" stream={focused} alt={focused.name}/>
            {streamAuthor(focused)}{focused.id === listeningId && streamVolume(focused)}</> : tile(focused, true)}
          <button type="button" className="icon-button dev-stream-expand"
            title={fullscreen ? labels.exitFull : labels.full} aria-label={fullscreen ? labels.exitFull : labels.full}
            onClick={() => void toggleFullscreen()}>
            <Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={17}/>
          </button>
        </div>
        {fullscreenError && <p role="alert" className="text-error">{labels.fullscreenError}</p>}
        {thumbnails.length > 0 && <div className="dev-stream-filmstrip">
          {thumbnails.map(stream => <Fragment key={stream.id}>{tile(stream)}</Fragment>)}
        </div>}
      </div> : <div className="dev-stream-grid"
        style={{ '--columns': columns, '--rows': rows } as CSSProperties}>
        {gridRows.map((row, index) => <div className="dev-stream-row" key={index}>
          {row.map(stream => <Fragment key={stream.id}>{tile(stream)}</Fragment>)}
        </div>)}
      </div>}
    </div>}
    <footer className="dev-stream-footer">
      {streams.length > 0 && <div className="room-participants dev-stream-roster" aria-label={t('Участники')}>{participants}</div>}
      <div className="dev-stream-toolbar">
        <div className="member-call-controls call-controls">
          {audioControls}
          <ScreenShareControls session={session} snapshot={live.snapshot} onStop={motion.capture}/>
          <button type="button" className="icon-button call-leave member-voice-disconnect" aria-label={t('Отключиться от голоса')}
            title={t('Отключиться от голоса')} onClick={onLeave}><Icon name="exit" size={18}/></button>
        </div>
      </div>
    </footer>
    <div className="dev-stream-motion" ref={motion.overlay} aria-hidden="true" inert/>
  </section>;
}
