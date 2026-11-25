import { useCallback, useEffect, useRef } from 'react';

export function useIncomingChatMotion() {
  const frame = useRef(0);
  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);
  useEffect(() => cancel, [cancel]);

  const play = useCallback((list: HTMLElement, rows: HTMLElement[], onScroll: () => void) => {
    if (!rows.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const duration = 220;
    for (const row of rows) row.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' });
    cancel();
    const from = list.scrollTop;
    const started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const bottom = list.scrollHeight - list.clientHeight;
      list.scrollTop = from + (bottom - from) * (1 - (1 - progress) ** 3);
      frame.current = progress < 1 ? requestAnimationFrame(tick) : 0;
      onScroll();
    };
    frame.current = requestAnimationFrame(tick);
    return true;
  }, [cancel]);

  return { frame, cancel, play };
}
