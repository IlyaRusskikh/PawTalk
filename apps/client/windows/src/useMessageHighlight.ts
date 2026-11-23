import { useCallback, useEffect, useRef } from 'react';

export function useMessageHighlight() {
  const current = useRef<HTMLElement>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    current.current?.classList.remove('chat-message-target');
    current.current = undefined;
  }, []);
  useEffect(() => clear, [clear]);

  return useCallback((row: HTMLElement) => {
    clear();
    current.current = row;
    row.classList.add('chat-message-target');
    timer.current = setTimeout(clear, 1600);
  }, [clear]);
}
