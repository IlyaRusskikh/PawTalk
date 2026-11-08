import type { ReactNode } from 'react';
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    paw: <g fill="currentColor" stroke="none"><ellipse cx="5" cy="9" rx="2.4" ry="3.2" transform="rotate(-25 5 9)"/><ellipse cx="10" cy="5" rx="2.3" ry="3" transform="rotate(-8 10 5)"/><ellipse cx="16" cy="5.5" rx="2.3" ry="3" transform="rotate(14 16 5.5)"/><ellipse cx="20" cy="10" rx="2.3" ry="3" transform="rotate(30 20 10)"/><path d="M6 16c1.5-1.5 2.7-5 6-5s4.5 3.5 6 5c3 3-1 6-4 4.5a4.5 4.5 0 0 0-4 0C7 22 3 19 6 16Z"/></g>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
    'zoom-in': <><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M10 7v6M7 10h6"/></>,
    'zoom-out': <><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m2 10v-3a5 5 0 0 0-2-4"/></>,
    offline: <><path d="m3 3 18 18M2 8a17 17 0 0 1 3-2m4-2a17 17 0 0 1 13 4M5 12a11 11 0 0 1 4-2m5 0a11 11 0 0 1 5 2M8 16a6 6 0 0 1 4-1m0 5h.01"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></>,
    wave: <path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8Z"/><path d="M7 11h.01M9 7h.01M14 6h.01M17 9h.01"/></>,
    reply: <path d="m9 5-7 7 7 7v-5h5c4 0 6 2 8 5 0-9-5-12-13-12z"/>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    send: <path d="m3 3 19 9-19 9 4-9zm4 9h15"/>,
    chat: <path d="M21 11a9 9 0 0 1-9 9H7l-5 2 2-5v-6a9 9 0 0 1 17 0Z"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8l-6.2 3.2L7 14.2l-5-4.9 6.9-1z"/>,
    edit: <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/>,
    chevron: <path d="m6 14 6-6 6 6"/>,
    'chevron-right': <path d="m9 6 6 6-6 6"/>,
    'arrow-down': <path d="M12 4v16m-6-6 6 6 6-6"/>,
    bookmark: <><path d="M6 3h12v19l-6-4-6 4z"/><path d="M12 7v6M9 10h6"/></>,
    invite: <><circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 13-3M19 8v8M15 12h8"/></>,
    'mic-off': <><path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 5M12 19v3M8 22h8"/></>,
    'headphones-off': <><path d="m3 3 18 18M3 14v-2a9 9 0 0 1 1-4M8 4a9 9 0 0 1 13 8v2"/><rect x="2" y="12" width="5" height="9" rx="2"/><path d="M17 14v5a2 2 0 0 0 2 2h1"/></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>,
    headphones: <><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2" y="12" width="5" height="9" rx="2"/><rect x="17" y="12" width="5" height="9" rx="2"/></>,
    sound: <><path d="m3 9 4 0 5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8M19 4a11 11 0 0 1 0 16"/></>,
    settings: <><path d="M9.02 4.79L10.38 4.37L10.61 2.10L13.39 2.10L13.62 4.37L14.98 4.79L14.98 4.79L16.25 5.46L18.02 4.01L19.99 5.98L18.54 7.75L19.21 9.02L19.21 9.02L19.63 10.38L21.90 10.61L21.90 13.39L19.63 13.62L19.21 14.98L19.21 14.98L18.54 16.25L19.99 18.02L18.02 19.99L16.25 18.54L14.98 19.21L14.98 19.21L13.62 19.63L13.39 21.90L10.61 21.90L10.38 19.63L9.02 19.21L9.02 19.21L7.75 18.54L5.98 19.99L4.01 18.02L5.46 16.25L4.79 14.98L4.79 14.98L4.37 13.62L2.10 13.39L2.10 10.61L4.37 10.38L4.79 9.02L4.79 9.02L5.46 7.75L4.01 5.98L5.98 4.01L7.75 5.46L9.02 4.79Z"/><circle cx="12" cy="12" r="3.3"/></>,
    signal: <><path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/></>,
    exit: <><path d="M10 4H4v16h6M10 12h11m-4-4 4 4-4 4"/></>,
    shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6zM8 12l3 3 5-6"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.mic}</svg>;
}
export function Toggle({ label, detail, checked, onChange, disabled }: { label: string; detail?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={`toggle-row ${disabled ? 'disabled' : ''}`}><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled}/></label>;
}
export function Slider({ label, value, min, max, step = 1, format, onChange }: { label: string; value: number; min: number; max: number; step?: number; format?: string; onChange: (value: number) => void }) {
  return <label className="slider-label"><span>{label}<b>{format ?? value}</b></span><input style={{ background: `linear-gradient(to right, var(--accent) ${(value-min)/(max-min)*100}%, var(--line) ${(value-min)/(max-min)*100}%)` }} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))}/></label>;
}
