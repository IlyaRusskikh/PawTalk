import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon, Slider } from './Controls';
import { t } from './i18n';
import type { Settings } from './settings';
import { audioDeviceLabel } from './audioDeviceLabel';

export function AudioQuickMenu({ kind, settings, update, devices, onOpen, children }: {
  kind: 'input' | 'output'; settings: Settings; devices: MediaDeviceInfo[];
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onOpen: () => Promise<void>; children: ReactNode;
}) {
  const id = useId();
  const deviceListId = `${id}-devices`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const deviceTrigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 8, bottom: 80 });
  const [deviceListPosition, setDeviceListPosition] = useState({ left: 8, top: 8 });
  const input = kind === 'input';
  const deviceKey = input ? 'inputDevice' : 'outputDevice';
  const volumeKey = input ? 'inputGain' : 'outputVolume';
  const label = input ? t("Устройство ввода") : t("Устройство вывода");
  const icon = input ? 'mic' : 'headphones';
  const matchingDevices = devices.filter(device => device.kind === (input ? 'audioinput' : 'audiooutput'));
  const defaultName = audioDeviceLabel(matchingDevices.find(device => device.deviceId === 'default')?.label.replace(/^(default|по умолчанию)\s*[-–—:]\s*/i, '') ?? '');
  const choices = [
    { id: 'default', name: t("Системное устройство"), detail: defaultName },
    ...matchingDevices.filter(device => device.deviceId && !['default', 'communications'].includes(device.deviceId)).map((device, index) => ({
      id: device.deviceId,
      name: audioDeviceLabel(device.label) || (input ? t("Микрофон {0}", index + 1) : t("Динамик {0}", index + 1)),
      detail: undefined,
    })),
  ];
  const selected = choices.find(choice => choice.id === settings[deviceKey]) ?? choices[0];

  return <div className="audio-control">{children}<button ref={trigger} className="icon-button audio-arrow" title={label} aria-label={label} popoverTarget={id}><Icon name="chevron" size={12}/></button>
    <div ref={menu} id={id} popover="auto" className="audio-quick-menu" style={position} onToggle={event => {
      if (event.target !== event.currentTarget) return;
      if (event.newState === 'open') {
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), bottom: window.innerHeight - rect.top + 10 });
        void onOpen();
      }
    }}>
      <button ref={deviceTrigger} className="audio-device-trigger" type="button" popoverTarget={deviceListId}>
        <span className="audio-device-text"><strong>{label}</strong><small title={selected.detail || selected.name}>{selected.detail || selected.name}</small></span>
        <Icon name="chevron-right" size={16}/>
      </button>
      <div id={deviceListId} popover="auto" className="audio-device-list" role="group" aria-label={label} style={deviceListPosition}
        onBeforeToggle={event => {
          if (event.newState !== 'open') return;
          const rect = menu.current!.getBoundingClientRect();
          const left = rect.right + 260 <= window.innerWidth ? rect.right + 4 : Math.max(8, rect.left - 260);
          const height = Math.min(320, choices.length * 52 + 14);
          setDeviceListPosition({ left, top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)) });
        }}
        onToggle={event => {
          if (event.newState === 'open') event.currentTarget.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
        }}
      >{choices.map(choice => <button key={choice.id} className="audio-device-option" type="button" aria-pressed={choice.id === selected.id} title={choice.detail || choice.name}
        onClick={event => {
          update(deviceKey, choice.id);
          event.currentTarget.closest<HTMLElement>('.audio-device-list')?.hidePopover();
          deviceTrigger.current?.focus();
        }}>
        <Icon name={icon} size={17}/>
        <span className="audio-device-text"><strong>{choice.name}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
        <span className="audio-device-indicator" aria-hidden="true"/>
      </button>)}</div>
      <Slider label={input ? t("Громкость микрофона") : t("Громкость динамика")} min={0} max={2} step={0.05} value={settings[volumeKey]} format={`${Math.round(settings[volumeKey] * 100)}%`} onChange={value => update(volumeKey, value)}/>
    </div>
  </div>;
}
