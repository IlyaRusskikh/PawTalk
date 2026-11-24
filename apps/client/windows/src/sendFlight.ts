type Point = { x: number; y: number };

export function composerTextOrigin(field: HTMLTextAreaElement | null): Point | undefined {
  if (!field) return;
  const rect = field.getBoundingClientRect();
  const style = getComputedStyle(field);
  return {
    x: rect.left + field.clientLeft + parseFloat(style.paddingLeft),
    y: rect.top + field.clientTop + parseFloat(style.paddingTop),
  };
}

export function animateSendFlight(history: HTMLElement, target: HTMLElement, origin: Point, onFinish: () => void) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = target.getBoundingClientRect();
  const viewport = history.getBoundingClientRect();
  if (!rect.width || rect.bottom <= viewport.top || rect.top >= viewport.bottom) return;
  // A transformed descendant changes the scrollable overflow of the chat.
  const layer = document.createElement('div');
  layer.className = 'member-message chat-message chat-message-pending chat-send-flight';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  const left = Math.min(viewport.left, origin.x);
  Object.assign(layer.style, {
    position: 'fixed', left: left + 'px', top: viewport.top + 'px',
    width: (viewport.right - left) + 'px', bottom: '0', padding: '0', margin: '0',
    overflow: 'clip', pointerEvents: 'none', zIndex: '30',
  });
  const body = document.createElement('div');
  body.className = 'member-message-content chat-message-body';
  Object.assign(body.style, {
    position: 'absolute', left: (rect.left - left) + 'px',
    top: (rect.top - viewport.top) + 'px', width: rect.width + 'px',
  });
  const copy = target.cloneNode(true) as HTMLElement;
  copy.style.visibility = '';
  body.append(copy);
  layer.append(body);
  document.body.append(layer);

  const animation = copy.animate([
    { transform: `translate(${origin.x - rect.left}px, ${origin.y - rect.top}px)`, opacity: 0.6 },
    { transform: 'none', opacity: 1 },
  ], { duration: 220, easing: 'ease-out' });
  let done = false;
  const finish = (notify = true) => {
    if (done) return;
    done = true;
    layer.remove();
    animation.cancel();
    if (notify) onFinish();
  };
  void animation.finished.then(() => finish(), () => finish());
  return finish;
}
