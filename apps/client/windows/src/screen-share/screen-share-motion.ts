import { useEffect, useLayoutEffect, useRef } from 'react';

type Scene = { tiles: Map<string, { rect: DOMRect; video: HTMLVideoElement | null }>; people: Map<string, DOMRect> };
const timing = { duration: 360, easing: 'cubic-bezier(.22, 1, .36, 1)' };
const centeredAt = (from: DOMRect, to: DOMRect) => {
  const x = from.left + (from.width - to.width) / 2 - to.left;
  const y = from.top + (from.height - to.height) / 2 - to.top;
  return `translate(${x}px, ${y}px) scale(${from.width / to.width}, ${from.height / to.height})`;
};

function differs(from: DOMRect, to: DOMRect) {
  return to.width > 0 && to.height > 0 && [from.left - to.left, from.top - to.top,
    from.width - to.width, from.height - to.height].some(value => Math.abs(value) >= 1);
}

export function useStreamPreviewMotion(personIds: readonly string[], hasStreams: boolean, layoutKey: string | undefined) {
  const scope = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const pending = useRef<Scene>(null);
  const committed = useRef<{ key: string; scene: Scene }>(null);
  const ghosts = useRef(new Map<string, HTMLElement>());
  const running = useRef(new Set<Animation>());

  function tiles() {
    return Array.from(scope.current!.querySelectorAll<HTMLElement>('.dev-stream-tile[data-tile]'));
  }

  function people() {
    return Array.from(scope.current!.querySelectorAll<HTMLElement>('.person-card .person-visual'));
  }

  function readScene(): Scene {
    return {
      tiles: new Map(tiles().map(tile => {
        const id = tile.dataset.tile!;
        return [id, { rect: (ghosts.current.get(id) ?? tile).getBoundingClientRect(), video: tile.querySelector('video') }];
      })),
      people: new Map(people().map((person, index) => [personIds[index], person.getBoundingClientRect()])),
    };
  }
  function capture() {
    if (scope.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) pending.current = readScene();
  }

  function clear() {
    running.current.forEach(animation => animation.cancel());
    running.current.clear();
    ghosts.current.forEach(ghost => ghost.remove());
    ghosts.current.clear();
  }

  useEffect(() => clear, []);

  useLayoutEffect(() => {
    const root = scope.current;
    if (!root || layoutKey === undefined) return;
    const observer = new ResizeObserver(() => {
      if (!running.current.size && !pending.current) committed.current = { key: layoutKey, scene: readScene() };
    });
    observer.observe(root);
    if (root.parentElement) observer.observe(root.parentElement);
    people().forEach(person => observer.observe(person));
    return () => observer.disconnect();
  }, [layoutKey]);

  useLayoutEffect(() => {
    const layer = overlay.current;
    if (!layer || layoutKey === undefined) {
      pending.current = null;
      committed.current = null;
      clear();
      return;
    }
    const previous = pending.current ?? (committed.current?.key !== layoutKey ? committed.current?.scene : undefined);
    if (!previous) {
      if (!running.current.size) committed.current = { key: layoutKey, scene: readScene() };
      return;
    }
    pending.current = null;
    clear();
    committed.current = { key: layoutKey, scene: readScene() };
    if (!hasStreams || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const destinationPeople = people().map(person => ({ person, rect: person.getBoundingClientRect() }));
    destinationPeople.forEach(({ person, rect: to }, index) => {
      const from = previous.people.get(personIds[index]);
      if (!from || !differs(from, to)) return;
      const animation = person.animate([{ transform: centeredAt(from, to) }, { transform: 'none' }], timing);
      running.current.add(animation);
      animation.onfinish = () => { running.current.delete(animation); };
    });

    const bounds = layer.getBoundingClientRect();
    for (const tile of tiles()) {
      const id = tile.dataset.tile!;
      const fromTile = previous.tiles.get(id);
      const from = fromTile?.rect ?? previous.people.get(id) ?? destinationPeople[personIds.indexOf(id)]?.rect;
      const to = tile.getBoundingClientRect();
      if (!from || !differs(from, to)) continue;

      const video = fromTile?.video;
      if (tile.querySelector('video') && !video?.videoWidth) {
        const animation = tile.animate([{ transform: centeredAt(from, to), opacity: .65 }, { transform: 'none', opacity: 1 }], timing);
        running.current.add(animation);
        animation.onfinish = () => { running.current.delete(animation); };
        continue;
      }

      // A copy can cross the scrollable thumbnail strip without being clipped by it.
      const ghost = tile.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-tile');
      ghost.dataset.motionStream = id;
      ghost.querySelector('.dev-stream-volume-control')?.remove();
      ghost.querySelector('[data-stream]')?.removeAttribute('data-stream');
      if (video?.videoWidth) {
        const frame = document.createElement('canvas');
        frame.width = Math.min(video.videoWidth, 720);
        frame.height = Math.round(frame.width * video.videoHeight / video.videoWidth);
        frame.getContext('2d')?.drawImage(video, 0, 0, frame.width, frame.height);
        ghost.querySelector('video')?.replaceWith(frame);
      }
      Object.assign(ghost.style, {
        position: 'absolute',
        left: `${to.left - bounds.left}px`, top: `${to.top - bounds.top}px`,
        width: `${to.width}px`, height: `${to.height}px`,
        zIndex: tile.closest('.dev-stream-main-tile') ? '1' : '',
      });
      layer.append(ghost);
      ghosts.current.set(id, ghost);
      const animation = ghost.animate([
        { transform: centeredAt(from, to), opacity: fromTile ? 1 : 0.65 },
        { transform: 'none', opacity: 1 },
      ], timing);
      const conceal = tile.animate([{ opacity: 0 }, { opacity: 0 }], { duration: timing.duration, fill: 'forwards' });
      running.current.add(animation);
      running.current.add(conceal);
      animation.onfinish = () => {
        ghost.remove();
        if (ghosts.current.get(id) === ghost) ghosts.current.delete(id);
        conceal.cancel();
        running.current.delete(animation);
        running.current.delete(conceal);
      };
    }
  }, [layoutKey]);

  return { scope, overlay, capture };
}
