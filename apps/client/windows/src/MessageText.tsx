import type {Mention} from '../../../../shared/mentions.mjs';
import { messageMarkdown, type MarkdownNode } from '../../../../shared/chat-format.mjs';
import { t } from './i18n';

function render(nodes: MarkdownNode[], preview: boolean, labels: string[]): React.ReactNode {
  return nodes.map((node, i) => {
    if (typeof node === 'string') {
      if(!labels.length)return node;
      const escaped=labels.map(label=>label.split('').map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('')).join('|');
      return node.split(new RegExp('('+escaped+')','g')).map((part,j)=>labels.includes(part)?<span className="chat-mention" key={i+'-'+j}>{part}</span>:part);
    }
    const children = node.children ? render(node.children, preview, labels) : node.text;
    switch (node.type) {
      case 'bold': return <strong key={i}>{children}</strong>;
      case 'italic': return <em key={i}>{children}</em>;
      case 'boldItalic': return <strong key={i}><em>{children}</em></strong>;
      case 'underline': return <u key={i}>{children}</u>;
      case 'strike': return <s key={i}>{children}</s>;
      case 'code': return <code key={i}>{children}</code>;
      case 'pre': return <span className="chat-code-block" key={i}><code>{children}</code></span>;
      case 'link': return preview ? <span key={i}>{children}</span> : <a key={i} href={node.url} target="_blank" rel="noopener noreferrer">{children}</a>;
      case 'spoiler': if (preview) return <span key={i} className="chat-spoiler" aria-expanded="false">{children}</span>; return <button key={i} type="button" className="chat-spoiler" aria-label={t("Показать спойлер")} aria-expanded="false" onClick={event => { const button = event.currentTarget; const shown = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(shown)); button.setAttribute('aria-label', t(shown ? "Скрыть спойлер" : "Показать спойлер")); }}>{children}</button>;
      default: return <span key={i} className={`chat-markdown-${node.type}`} data-level={node.level}>{children || '\u00a0'}</span>;
    }
  });
}
export function MessageText({ text, preview = false, mentions=[] }: { text: string; preview?: boolean; mentions?:Mention[] }) { return <>{render(messageMarkdown(text), preview,mentions.map(m=>text.slice(m.start,m.end)))}</>; }
