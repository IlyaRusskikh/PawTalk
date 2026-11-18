import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';

type Placement = { ids: string[]; tops: number[]; steps: number[]; from: number; to: number; commit(ids: string[]): void };

// Use a separate transparent surface: Chromium otherwise captures the sidebar
// behind rounded buttons as part of its native drag image.
export function setTransparentDragImage(event: DragEvent<HTMLElement>) {
  const source = event.currentTarget, box = source.getBoundingClientRect();
  const surface = document.createElement('div'), copy = source.cloneNode(true) as HTMLElement;
  surface.className = 'member-drag-image';
  Object.assign(surface.style, { position: 'fixed', left: '-10000px', top: '0', padding: '6px', background: 'transparent', pointerEvents: 'none' });
  Object.assign(copy.style, { width: `${box.width}px`, height: `${box.height}px`, margin: '0', transform: 'none', boxShadow: 'none', backgroundColor: getComputedStyle(source).backgroundColor });
  copy.removeAttribute('id'); copy.removeAttribute('aria-describedby');
  copy.querySelectorAll('.member-unread-badge,.member-channel-count').forEach(node => node.remove());
  surface.append(copy); document.body.append(surface);
  event.dataTransfer.setDragImage(surface, Math.max(0, event.clientX - box.left) + 6, Math.max(0, event.clientY - box.top) + 6);
  // The browser snapshots the image after dragstart has returned.
  setTimeout(() => surface.remove(), 0);
}

export function useReorderDrag(ids: string[], commit: (ids: string[]) => void) {
  const drag = useRef<Placement | undefined>(undefined), suppressClick = useRef(0);
  const [placement, setPlacement] = useState<Placement>();
  const signature = JSON.stringify(ids), latest = useRef(signature); latest.current = signature;
  function end() { drag.current = undefined; setPlacement(undefined); suppressClick.current = Date.now() + 200; }
  useEffect(() => { if (drag.current && JSON.stringify(drag.current.ids) !== signature) end(); }, [signature]);
  function slot(event: DragEvent<HTMLElement>, current: Placement) {
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top + event.currentTarget.scrollTop;
    let to = 0;
    while (to < current.tops.length - 1 && y >= (current.tops[to] + current.tops[to + 1]) / 2) to++;
    return to;
  }
  const list = {
    'data-reorder-list': true,
    'data-reordering': !!placement,
    onDragOver(event: DragEvent<HTMLElement>) {
      const current = drag.current;
      if (!current || JSON.stringify(current.ids) !== latest.current) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      const to = slot(event, current);
      if (to !== current.to) { current.to = to; setPlacement({ ...current }); }
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX >= r.right || event.clientY < r.top || event.clientY >= r.bottom) {
        if (drag.current) { drag.current.to = drag.current.from; setPlacement({ ...drag.current }); }
      }
    },
    onDrop(event: DragEvent<HTMLElement>) {
      const current = drag.current;
      if (!current) return;
      event.preventDefault();
      const to = slot(event, current), valid = JSON.stringify(current.ids) === latest.current;
      end();
      if (!valid || to === current.from) return;
      const next = [...current.ids]; next.splice(to, 0, next.splice(current.from, 1)[0]); current.commit(next);
    },
  };
  function item(id: string) {
    const index = placement?.ids.indexOf(id) ?? -1;
    let offset = 0;
    if (placement && index >= 0) {
      const { from, to, steps } = placement;
      if (index === from) {
        if (from < to) for (let i = from + 1; i <= to; i++) offset += steps[i];
        else for (let i = to; i < from; i++) offset -= steps[i];
      } else if (from < index && index <= to) offset = -steps[from];
      else if (to <= index && index < from) offset = steps[from];
    }
    return { 'data-reorder-id': id, 'data-reorder-source': placement?.ids[placement.from] === id || undefined,
      style: { transform: offset ? `translateY(${offset}px)` : undefined } as CSSProperties };
  }
  function start(event: DragEvent<HTMLElement>, id: string) {
    const parent = event.currentTarget.closest<HTMLElement>('[data-reorder-list]');
    if (!parent) return;
    const elements = Array.from(parent.querySelectorAll<HTMLElement>(':scope > [data-reorder-id]'));
    const boxes = elements.map(element => element.getBoundingClientRect()), origin = parent.getBoundingClientRect().top - parent.scrollTop;
    const from = ids.indexOf(id);
    if (from < 0 || elements.length !== ids.length) { event.preventDefault(); return; }
    const gap = boxes.length > 1 ? boxes[1].top - boxes[0].bottom : 0;
    const current = { ids: [...ids], tops: boxes.map(box => box.top + box.height / 2 - origin), steps: boxes.map(box => box.height + gap), from, to: from, commit };
    drag.current = current; suppressClick.current = Infinity;
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); setTransparentDragImage(event);
    // Let Chromium capture the image before hiding the source in the list.
    requestAnimationFrame(() => { if (drag.current === current) setPlacement({ ...current }); });
  }
  return { list, item, start, end, suppressClick: () => Date.now() < suppressClick.current };
}
