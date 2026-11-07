import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Toast({ children, onDismiss }: { children: ReactNode; onDismiss(): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activity, setActivity] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => {
    setLeaving(false);
    if (hovered || focused) return;
    const timer = setTimeout(() => setLeaving(true), 5000);
    return () => clearTimeout(timer);
  }, [hovered, focused, activity]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => dismiss.current(), 200);
    return () => clearTimeout(timer);
  }, [leaving]);
  return <div className={`toast${leaving ? ' toast-leaving' : ''}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onPointerDownCapture={() => { setLeaving(false); setActivity(value => value + 1); }} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>{children}</div>;
}
