// Parse a bounded, HTML-free subset of Discord Markdown. Never interpret HTML.
export function inlineMarkdown(text, depth = 0) {
  if (depth > 12) return [text];
  const nodes = [];
  const add = value => { if (typeof value === 'string' && typeof nodes.at(-1) === 'string') nodes[nodes.length - 1] += value; else nodes.push(value); };
  const marks = [['***', 'boldItalic'], ['**', 'bold'], ['__', 'underline'], ['~~', 'strike'], ['||', 'spoiler'], ['*', 'italic'], ['_', 'italic']];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\*_~|`\[\]()]/.test(text[i + 1] ?? '')) { add(text[i + 1]); i += 2; continue; }
    if (text[i] === '`') {
      const mark = text.startsWith('``', i) ? '``' : '`';
      const end = text.indexOf(mark, i + mark.length);
      if (end > i + mark.length) { add({ type: 'code', text: text.slice(i + mark.length, end) }); i = end + mark.length; continue; }
    }
    const link = text.slice(i).match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s<>\u0000-\u001f)]+)\)/)
      ?? text.slice(i).match(/^(https?:\/\/[^\s<>\u0000-\u001f]+)/);
    if (link) {
      const url = link[2] ?? link[1];
      try { const parsed = new URL(url); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        add({ type: 'link', url, children: [link[2] ? link[1] : url] }); i += link[0].length; continue;
      } } catch { /* Render malformed URLs as ordinary text. */ }
    }
    let matched = false;
    for (const [mark, type] of marks) {
      if (!text.startsWith(mark, i)) continue;
      let end = text.indexOf(mark, i + mark.length);
      while (end >= 0 && text[end - 1] === '\\') end = text.indexOf(mark, end + mark.length);
      if (end <= i + mark.length) continue;
      if (mark === '**' || mark === '__') while (text[end + mark.length] === mark[0]) end++;
      add({ type, children: inlineMarkdown(text.slice(i + mark.length, end), depth + 1) });
      i = end + mark.length; matched = true; break;
    }
    if (!matched) add(text[i++]);
  }
  return nodes;
}

export function messageMarkdown(text) {
  const lines = text.split('\n'), nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body = []; let end = i + 1;
      while (end < lines.length && !lines[end].startsWith('```')) body.push(lines[end++]);
      if (end < lines.length) { nodes.push({ type: 'pre', text: body.join('\n') }); i = end; continue; }
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const list = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    nodes.push({ type: heading ? 'heading' : quote ? 'quote' : list ? 'item' : 'line', level: heading?.[1].length,
      children: inlineMarkdown(heading?.[2] ?? quote?.[1] ?? list?.[1] ?? line) });
  }
  return nodes;
}
