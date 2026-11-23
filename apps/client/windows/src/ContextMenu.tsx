import { useEffect, useRef } from 'react';
import { Icon } from './Controls';

export type MenuItem = { label: string; action(): void; danger?: boolean; disabled?: boolean; icon?: string; separatorBefore?: boolean };

export function ContextMenu({ x, y, items, anchor, onClose }: {
  x: number; y: number; items: MenuItem[]; anchor?: HTMLElement; onClose(): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const menu = element.current!;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !anchor?.contains(event.target as Node)) close.current();
    };
    const resize = () => close.current();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', resize);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [x, y, anchor, items.length]);

  return <div ref={element} className="member-context" role="menu" style={{ left: x, top: y }} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(element.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>{items.map((item, index) => <button type="button" role="menuitem" className={item.danger ? 'text-error' : ''}
    data-separator-before={item.separatorBefore || undefined} key={index} disabled={item.disabled}
    onClick={() => { onClose(); item.action(); }}>{item.icon && <Icon name={item.icon} size={16}/>}<span>{item.label}</span></button>)}</div>;
}
