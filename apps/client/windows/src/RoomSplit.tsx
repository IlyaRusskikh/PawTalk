import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Icon } from './Controls';
import { t } from './i18n';

const dividerSize = 12;
type Placement = 'bottom' | 'right';
type Drop = 'hide' | 'move';
type Drag = { pointer: number; offset: number; targetY: number; ratio: number };

export function RoomSplit({ visible, participants, chat, movableChat }: {
  visible: boolean; participants: ReactNode; chat: ReactNode;
  movableChat?: { hide: string; restore: string; right: string; bottom: string };
}) {
  const container = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLButtonElement>(null);
  const hideTarget = useRef<HTMLSpanElement>(null);
  const moveTarget = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag>(null);
  const changedVisibility = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ratios, setRatios] = useState({ bottom: 0.43, right: 0.64 });
  const [placement, setPlacement] = useState<Placement>('bottom');
  const [chatHidden, setChatHidden] = useState(false);
  const [grip, setGrip] = useState<{ x: number; y: number; targetY: number; over?: Drop }>();

  useLayoutEffect(() => {
    const pane = container.current!;
    const resize = () => setSize({ width: pane.clientWidth, height: pane.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!changedVisibility.current) return;
    changedVisibility.current = false;
    (chatHidden ? restore.current : divider.current)?.focus({ preventScroll: true });
  }, [chatHidden]);

  useLayoutEffect(() => {
    if (visible) return;
    setChatHidden(false);
    setPlacement('bottom');
  }, [visible]);

  const side = placement === 'right';
  const dimension = side ? size.width : size.height;
  const available = Math.max(0, dimension - dividerSize);
  const chatMinimum = side ? Math.min(240, Math.round(available * 0.45)) : 154;
  const max = Math.max(0, available - chatMinimum);
  const min = Math.min(side ? 300 : 196, max);
  const extent = Math.max(min, Math.min(max, Math.round(available * ratios[placement])));
  const percent = (pixels: number) => available > 0 ? Math.round(pixels / available * 100) : 0;
  const tracks = [extent + 'px', dividerSize + 'px', 'minmax(0, 1fr)'].join(' ');
  const style = dimension > 0 && !chatHidden
    ? side ? { gridTemplateColumns: tracks } : { gridTemplateRows: tracks }
    : undefined;

  function resizeTo(pixels: number) {
    if (available > 0) setRatios(previous => ({ ...previous, [placement]: Math.max(min, Math.min(max, pixels)) / available }));
  }

  function setHidden(hidden: boolean) {
    changedVisibility.current = true;
    setChatHidden(hidden);
  }

  function applyDrop(target: Drop) {
    if (target === 'hide') setHidden(true);
    else setPlacement(side ? 'bottom' : 'right');
  }

  function targetAt({ clientX, clientY }: PointerEvent): Drop | undefined {
    function contains(element: HTMLElement | null) {
      const rect = element?.getBoundingClientRect();
      return rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }
    if (contains(hideTarget.current)) return 'hide';
    if (contains(moveTarget.current)) return 'move';
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const line = handle.getBoundingClientRect();
    const pane = container.current!.getBoundingClientRect();
    const x = event.clientX - pane.left;
    const y = event.clientY - pane.top;
    const targetY = Math.max(28, Math.min(pane.height - 28, y));
    drag.current = {
      pointer: event.pointerId,
      offset: side ? event.clientX - line.left : event.clientY - line.top,
      targetY,
      ratio: ratios[placement],
    };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    if (movableChat) setGrip({ x, y, targetY });
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    const pane = container.current!.getBoundingClientRect();
    const x = event.clientX - pane.left;
    const y = event.clientY - pane.top;
    const over = movableChat ? targetAt(event) : undefined;
    if (movableChat) setGrip({ x, y, targetY: active.targetY, over });
    if (!over) resizeTo((side ? x : y) - active.offset);
  }

  function finishDrag(pointer: number, target?: Drop, cancelled = false) {
    const active = drag.current;
    if (active?.pointer !== pointer) return;
    drag.current = null;
    setGrip(undefined);
    if (movableChat && (cancelled || target)) {
      setRatios(previous => ({ ...previous, [placement]: active.ratio }));
    }
    if (target) applyDrop(target);
  }

  return <div className="room-split" data-chat-placement={movableChat ? chatHidden ? 'hidden' : placement : undefined}
    ref={container} hidden={!visible} style={style}>
    <section className="room-participants" id="room-participants" aria-label={t('Участники')}>{participants}</section>
    {!chatHidden && <div className="room-divider" ref={divider} role="separator" aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label={t('Размер области участников')} aria-controls="room-participants"
      aria-keyshortcuts={movableChat ? 'Shift+ArrowLeft Shift+ArrowRight' : undefined}
      aria-valuemin={percent(min)} aria-valuemax={percent(max)} aria-valuenow={percent(extent)} tabIndex={0}
      data-dragging={grip ? true : undefined}
      onPointerDown={startDrag} onPointerMove={moveDrag}
      onPointerUp={event => finishDrag(event.pointerId, movableChat ? targetAt(event) : undefined)}
      onPointerCancel={event => finishDrag(event.pointerId, undefined, true)}
      onLostPointerCapture={event => finishDrag(event.pointerId, undefined, true)}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) {
          const { pointer } = drag.current;
          finishDrag(pointer, undefined, true);
          if (event.currentTarget.hasPointerCapture(pointer)) event.currentTarget.releasePointerCapture(pointer);
          event.preventDefault();
          return;
        }
        if (drag.current) return;
        if (movableChat && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault();
          applyDrop(event.key === 'ArrowLeft' ? 'hide' : 'move');
          return;
        }
        const targets: Record<string, number> = side ? { ArrowLeft: extent - 16, ArrowRight: extent + 16, Home: min, End: max }
          : { ArrowUp: extent - 16, ArrowDown: extent + 16, Home: min, End: max };
        const target = targets[event.key];
        if (target === undefined) return;
        event.preventDefault();
        resizeTo(target);
      }}/>}
    {movableChat ? <div className="room-split-chat" hidden={chatHidden}>{chat}</div> : chat}
    {chatHidden && movableChat && <button type="button" ref={restore} className="icon-button room-chat-restore"
      aria-label={movableChat.restore} title={movableChat.restore} onClick={() => setHidden(false)}>
      <Icon name="chat" size={17}/>
    </button>}
    {grip && movableChat && <div className="room-dock-overlay" aria-hidden="true">
      <span className="room-dock-grip" style={{ left: grip.x, top: grip.y }}/>
      <span className="room-dock-target" ref={hideTarget} data-drop="hide" data-active={grip.over === 'hide'}
        style={{ top: grip.targetY }}>
        <Icon name="panel-hide" size={20}/><span>{movableChat.hide}</span>
      </span>
      <span className="room-dock-target" ref={moveTarget} data-drop="move" data-active={grip.over === 'move'}
        style={{ top: grip.targetY }}>
        <Icon name={side ? 'panel-bottom' : 'panel-right'} size={20}/>
        <span>{side ? movableChat.bottom : movableChat.right}</span>
      </span>
    </div>}
  </div>;
}
