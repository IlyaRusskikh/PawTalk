export type ChatReadingAnchor = { element: Element; offset: number; scrollTop: number; scrollHeight: number };

export function captureChatReadingAnchor(list: HTMLElement): ChatReadingAnchor | undefined {
  const { top, bottom } = list.getBoundingClientRect();
  const middle = (top + bottom) / 2;
  let row: Element | undefined;
  let distance = Infinity;
  for (const candidate of list.querySelectorAll('.chat-message-row')) {
    const bounds = candidate.getBoundingClientRect();
    if (bounds.bottom <= top) continue;
    if (bounds.top >= bottom) break;
    const gap = Math.max(0, bounds.top - middle, middle - bounds.bottom);
    if (gap >= distance) break;
    row = candidate;
    distance = gap;
  }
  if (!row) return;
  // Keep the part of the conversation being viewed stable when a poll or
  // attachment closer to the top finishes loading.
  const media = [...row.querySelectorAll('.video-poster, .chat-image')].find(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top <= middle && bounds.bottom > middle;
  });
  // A voter strip can move the options below it without moving the poll card.
  const poll = row.querySelector('.poll-card');
  let pollAnchor: Element | undefined;
  if (poll) {
    const bounds = poll.getBoundingClientRect();
    if (bounds.top <= middle && bounds.bottom > middle) {
      let nearest = Infinity;
      for (const item of poll.querySelectorAll('.poll-question, .poll-answer, .poll-footer')) {
        const { top, bottom } = item.getBoundingClientRect();
        const gap = Math.max(0, top - middle, middle - bottom);
        if (gap >= nearest) break;
        nearest = gap;
        pollAnchor = item;
      }
    }
  }
  const element = media ?? pollAnchor ?? row.querySelector('.member-message-text') ?? row;
  return { element, offset: element.getBoundingClientRect().top - top,
    scrollTop: list.scrollTop, scrollHeight: list.scrollHeight };
}

export function restoreChatReadingAnchor(list: HTMLElement, anchor?: ChatReadingAnchor) {
  if (!anchor || !list.contains(anchor.element)) return false;
  // The reader can scroll again between the snapshot and ResizeObserver. Correct
  // only movement within the document, keeping the reader's new scroll delta.
  const expectedOffset = anchor.offset - (list.scrollTop - anchor.scrollTop);
  const correction = anchor.element.getBoundingClientRect().top - list.getBoundingClientRect().top - expectedOffset;
  if (Math.abs(correction) >= 1) list.scrollTop += correction;
  return true;
}

export function chatScrollWasClamped(list: HTMLElement, previousTop: number) {
  return list.scrollTop < previousTop - 1 && list.scrollHeight - list.clientHeight - list.scrollTop < 1;
}
