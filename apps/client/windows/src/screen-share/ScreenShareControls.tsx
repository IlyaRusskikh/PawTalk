import { useId, useState } from 'react';
import { Icon } from '../Controls';
import { useLanguage } from '../i18n';
import type { Snapshot, VoiceSession } from '../session';
import { ScreenSharePicker, type ScreenShareQuality } from './ScreenSharePicker';

const copy = {
  ru: {
    show: 'Показать экран', stop: 'Остановить стрим', unavailable: 'Демонстрация недоступна в этом звонке',
    options: 'Настройки стрима', change: 'Смена источника',
  },
  en: {
    show: 'Share screen', stop: 'Stop stream', unavailable: 'Screen sharing is unavailable in this call',
    options: 'Stream options', change: 'Change source',
  },
};

export function ScreenShareControls({ session, snapshot, onStop, allowStart = true }: {
  session: VoiceSession; snapshot: Snapshot; onStop?(): void; allowStart?: boolean;
}) {
  const labels = copy[useLanguage()];
  const id = useId();
  const [position, setPosition] = useState({ left: 8, bottom: 80 });
  const [picker, setPicker] = useState<'start' | 'replace'>();
  const [quality, setQuality] = useState<ScreenShareQuality>({ resolution: 1080, fps: 30 });
  const sharing = snapshot.screens?.some(stream => stream.local);
  const canShare = snapshot.canShareScreen === true && !!window.desktop?.screenCaptureSources &&
    !!window.desktop.selectScreenCapture;
  const label = sharing ? labels.stop : labels.show;
  const button = <button type="button" className={`icon-button dev-stream-share ${!allowStart ? 'text-error' : ''}`}
    aria-pressed={!!sharing} disabled={!sharing && (!canShare || snapshot.screenPending)}
    aria-label={label} title={sharing || canShare ? label : labels.unavailable} onClick={() => {
      if (sharing) { onStop?.(); void session.stopScreenShare(); }
      else setPicker('start');
    }}>
    <Icon name={sharing ? 'monitor-stop' : 'monitor'} size={18}/>
  </button>;

  return <>
    {sharing ? <div className="audio-control">
      {button}
      <button type="button" className="icon-button audio-arrow" aria-label={labels.options} title={labels.options}
        popoverTarget={id} disabled={!canShare || snapshot.screenPending}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({ left: Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)),
            bottom: window.innerHeight - rect.top + 10 });
        }}><Icon name="chevron" size={12}/></button>
      <div id={id} popover="auto" className="audio-quick-menu dev-stream-options" style={position}>
        <button type="button" className="audio-device-option" onClick={event => {
          event.currentTarget.parentElement?.hidePopover();
          setPicker('replace');
        }}><Icon name="monitor" size={16}/>{labels.change}</button>
      </div>
    </div> : allowStart && button}
    {picker && <ScreenSharePicker session={session} canShareAudio={!!snapshot.canShareScreenAudio} replace={picker === 'replace'}
      quality={quality} onShare={setQuality} onClose={() => setPicker(undefined)}/>}
  </>;
}
