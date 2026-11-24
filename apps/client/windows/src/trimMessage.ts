export function trimMessage<T extends { start: number; end: number }>(source: string, mentions: readonly T[] = []) {
  const trimmed = source.trim();
  const start = source.length - source.trimStart().length;
  const end = start + trimmed.length;
  const removed: { start: number; end: number }[] = [];
  const text = trimmed.replace(/\n{4,}/g, (run, offset: number) => {
    removed.push({ start: offset + 3, end: offset + run.length });
    return '\n\n\n';
  });
  const offsetAfterTrim = (offset: number) => {
    const index = offset - start;
    return removed.reduce((result, run) => result - Math.max(0, Math.min(index, run.end) - run.start), index);
  };
  return {
    text,
    mentions: mentions.filter(span => span.start >= start && span.end <= end)
      .map(span => ({ ...span, start: offsetAfterTrim(span.start), end: offsetAfterTrim(span.end) })),
  };
}
