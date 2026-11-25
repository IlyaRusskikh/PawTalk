import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../ui/Button';
import { Icon } from '../Controls';
import { t, useLanguage } from '../i18n';
import type { VoiceSession } from '../session';
import { PawSpinner } from './StreamStatus';
import { attachApplicationAudio } from './application-audio';

const strings = {
  ru: {
    title: 'Показать экран', windows: 'Окна', screens: 'Мониторы', resolution: 'Разрешение',
    fps: 'Частота кадров', audio: 'Передавать системный звук', start: 'Начать стрим',
    loading: 'Загружаем источники…', empty: 'Доступных источников нет.',
    refresh: 'Обновить список', minimized: 'Разверните окно для захвата', unavailable: 'Захват окна недоступен', starting: 'Запускаем стрим…',
    original: 'Исходное',
    applicationAudio: 'Передавать звук приложения',
    applicationAudioScope: 'В стрим может попасть звук других окон этого приложения.',
    applicationAudioUnavailable: 'Для выбранного окна захват звука недоступен.',
    failed: 'Не удалось открыть демонстрацию. Выберите источник и попробуйте снова.',
  },
  en: {
    title: 'Share screen', windows: 'Windows', screens: 'Monitors', resolution: 'Resolution',
    fps: 'Frame rate', audio: 'Share system audio', start: 'Start stream',
    loading: 'Loading sources…', empty: 'No sources are available.',
    refresh: 'Refresh sources', minimized: 'Restore the window to capture it', unavailable: 'Window capture unavailable', starting: 'Starting stream…',
    original: 'Original',
    applicationAudio: 'Share application audio',
    applicationAudioScope: 'Audio from other windows of this application may also be shared.',
    applicationAudioUnavailable: 'Audio capture is unavailable for the selected window.',
    failed: 'Could not start screen sharing. Select a source and try again.',
  },
};

type Source = Awaited<ReturnType<NonNullable<NonNullable<Window['desktop']>['screenCaptureSources']>>>[number];
const qualityPresets = [
  { height: 360, name: 'SD (360p)' }, { height: 480, name: 'SD (480p)' }, { height: 720, name: 'HD' },
  { height: 1080, name: 'Full HD' }, { height: 1440, name: 'QHD' }, { height: 2160, name: '4K UHD' },
];

export function ScreenSharePicker({ session, canShareAudio, onClose }: {
  session: VoiceSession; canShareAudio: boolean; onClose(): void;
}) {
  const labels = strings[useLanguage()];
  const [kind, setKind] = useState<'window' | 'screen'>('window');
  const [sources, setSources] = useState<Source[]>();
  const [selected, setSelected] = useState<string>();
  const [preferredResolution, setResolution] = useState(1080);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fps, setFps] = useState(30);
  const [audio, setAudio] = useState(false);
  const [applicationAudio, setApplicationAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const starting = useRef(false);
  const source = sources?.find(item => item.id === selected && item.available);
  const maxHeight = source?.maxHeight ?? 0;
  const presets = qualityPresets.filter(item => item.height <= maxHeight);
  if (!presets.length && maxHeight) presets.push({ height: maxHeight, name: labels.original });
  const resolution = presets.filter(item => item.height <= preferredResolution).at(-1)?.height ?? presets[0]?.height;

  function refreshSources() {
    setLoading(true);
    setError(false);
    setRefresh(value => value + 1);
  }

  useEffect(() => {
    let active = true;
    void window.desktop?.screenCaptureSources?.(kind).then(items => {
      if (active) { setSources(items); setLoading(false); }
    }, () => {
      if (active) { setSources([]); setError(true); setLoading(false); }
    });
    return () => { active = false; };
  }, [kind, refresh]);

  useEffect(() => {
    if (kind !== 'window' || busy || loading) return;
    window.addEventListener('focus', refreshSources);
    return () => window.removeEventListener('focus', refreshSources);
  }, [kind, busy, loading]);

  useEffect(() => () => {
    if (starting.current) void session.stopScreenShare('picker-closed');
    void window.desktop?.clearScreenCapture?.().catch(() => {});
  }, [session]);

  async function start() {
    if (!source || loading || starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(false);
    const shareAudio = kind === 'screen' && canShareAudio && audio;
    const shareApplicationAudio = kind === 'window' && canShareAudio && source.applicationAudio === true && applicationAudio;
    try {
      await session.shareScreen(async () => {
        await window.desktop!.selectScreenCapture!(source.id, shareAudio, shareApplicationAudio);
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { height: { ideal: resolution, max: resolution }, frameRate: { ideal: fps, max: fps } },
          audio: shareAudio,
        });
        stream.getVideoTracks().forEach(track => { track.contentHint = 'detail'; });
        if (!shareApplicationAudio) return stream;
        try { return await attachApplicationAudio(stream); }
        catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
      }, { source: kind, requestedAudio: shareAudio || shareApplicationAudio });
      starting.current = false;
      onClose();
    } catch {
      starting.current = false;
      setError(true);
      setBusy(false);
    }
  }

  return <Modal title={labels.title} onClose={onClose} className="dev-stream-picker" footer={<div className="modal-actions">
    <Button onClick={onClose}>{t('Отмена')}</Button>
    <Button variant="primary" disabled={!source || busy || loading} onClick={() => void start()}>{busy ? <><PawSpinner/>{labels.starting}</> : labels.start}</Button>
  </div>}>
    <div className="dev-stream-picker-types">
      {(['window', 'screen'] as const).map(type => <Button key={type} disabled={busy} aria-pressed={kind === type} onClick={() => {
        if (type !== kind) { setSelected(undefined); setSources(undefined); setLoading(true); setError(false); setKind(type); }
      }}>{type === 'window' ? labels.windows : labels.screens}</Button>)}
      <Button disabled={busy || loading} onClick={refreshSources}>{labels.refresh}</Button>
    </div>
    <div className="dev-stream-sources" key={kind}>
      {error && <p role="alert">{labels.failed}</p>}
      {!sources?.length && !error && <p role="status">{loading ? labels.loading : labels.empty}</p>}
      {sources?.map(item => <button type="button" key={item.id} disabled={busy || loading || !item.available} aria-pressed={selected === item.id && item.available}
        title={item.name} onClick={() => {
          if (item.id !== selected) setApplicationAudio(false);
          setSelected(item.id);
        }}>
        {item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false}/> : <span className="screen-source-placeholder" aria-hidden="true">
          {item.icon ? <img src={item.icon} alt=""/> : <Icon name="monitor" size={24}/>}
        </span>}
        <span>{item.name}{!item.available && <small>{item.minimized ? labels.minimized : labels.unavailable}</small>}</span>
      </button>)}
    </div>
    <div className="form-fields">
      <div className="form-grid">
        <label>{labels.resolution}<select disabled={busy || !resolution} value={resolution ?? ''} onChange={event => setResolution(Number(event.currentTarget.value))}>
          {!resolution && <option value="">—</option>}
          {presets.map(item => <option key={item.height} value={item.height}>{item.name}</option>)}
        </select></label>
        <label>{labels.fps}<select disabled={busy} value={fps} onChange={event => setFps(Number(event.currentTarget.value))}>
          {[30, 60].map(value => <option key={value} value={value}>{value} FPS</option>)}
        </select></label>
      </div>
      {kind === 'screen' && canShareAudio && <label className="screen-share-audio-option">
        <input type="checkbox" disabled={busy} checked={audio} onChange={event => setAudio(event.currentTarget.checked)}/>{labels.audio}
      </label>}
      {kind === 'window' && canShareAudio && source && <div>
        <label className="screen-share-audio-option">
          <input type="checkbox" disabled={busy || !source.applicationAudio} checked={!!source.applicationAudio && applicationAudio}
            onChange={event => setApplicationAudio(event.currentTarget.checked)}/>{labels.applicationAudio}
        </label>
        <small className="muted">{source.applicationAudio ? labels.applicationAudioScope : labels.applicationAudioUnavailable}</small>
      </div>}
    </div>
  </Modal>;
}
