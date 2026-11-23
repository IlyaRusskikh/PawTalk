import { useEffect, useRef, useState } from 'react';
import { ChecklistItems } from './Checklist';
import { membership } from './membership';
import { MessageText } from './MessageText';

type ChecklistState = { revision: number; canCheck: boolean; checked: Record<string, boolean> };
type ChecklistChange = { item: string; checked: boolean; operationId: string };

export function ProtectedChecklist({ serverId, channelId, position, title, items, timedOut }: {
  serverId: string; channelId: string; position: number; title: string;
  items: { id: string; text: string }[]; timedOut?: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  const pendingChange = useRef<ChecklistChange | undefined>(undefined);
  const [state, setState] = useState<ChecklistState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function update(next: ChecklistState) {
    setState(previous => previous && previous.revision > next.revision ? previous : next);
  }

  useEffect(() => {
    const element = card.current;
    if (!element) return;
    let disposed = false;
    let visible = false;
    let reading = false;
    async function read() {
      if (reading || !visible) return;
      reading = true;
      try {
        const next = await membership<ChecklistState>('chat.protected.checklist', { serverId, channelId, position });
        if (!disposed) update(next);
      } catch {
        if (!disposed) setState(undefined);
      } finally {
        reading = false;
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) void read();
    });
    observer.observe(element);
    const timer = setInterval(() => void read(), 5000);
    return () => {
      disposed = true;
      observer.disconnect();
      clearInterval(timer);
    };
  }, [serverId, channelId, position]);

  async function check(item: string, checked: boolean) {
    if (busy || timedOut || !state?.canCheck) return;
    if (pendingChange.current?.item !== item || pendingChange.current.checked !== checked) {
      pendingChange.current = { item, checked, operationId: crypto.randomUUID().replaceAll('-', '') };
    }
    setError('');
    setBusy(true);
    try {
      update(await membership<ChecklistState>('chat.protected.checklist', { serverId, channelId, position, change: pendingChange.current }));
      pendingChange.current = undefined;
    } catch (failure) {
      setError((failure as Error).message);
      setState(undefined);
    } finally {
      setBusy(false);
    }
  }

  return <div ref={card} className="chat-checklist" aria-busy={!state || busy}>
    <strong><MessageText text={title}/></strong>
    <ChecklistItems items={items} checked={state?.checked ?? {}} disabled={!!timedOut || !state?.canCheck || busy} onCheck={check}/>
    {error && <p className="text-error" role="alert">{error}</p>}
  </div>;
}
