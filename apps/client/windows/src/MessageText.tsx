import {membership} from './membership';
import {useEffect,useRef,useState} from 'react';
import type {Mention} from '../../../../shared/mentions.mjs';
import { messageMarkdown, type MarkdownNode } from '../../../../shared/chat-format.mjs';
import { isGifProviderPage } from '../electron/gif-provider.mjs';
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
      case 'rule': return <hr key={i}/>;
      case 'table': return <span className="chat-markdown-table-wrap" key={i}><table><tbody>{children}</tbody></table></span>;
      case 'header': case 'row': return <tr key={i}>{children}</tr>;
      case 'cell': return <td key={i}>{children}</td>;
      case 'bold': return <strong key={i}>{children}</strong>;
      case 'italic': return <em key={i}>{children}</em>;
      case 'boldItalic': return <strong key={i}><em>{children}</em></strong>;
      case 'underline': return <u key={i}>{children}</u>;
      case 'strike': return <s key={i}>{children}</s>;
      case 'code': return <code key={i}>{children}</code>;
      case 'pre': return <span className="chat-code-block" key={i}><code>{children}</code></span>;
      case 'link': return preview ? <span key={i}>{children}</span> : <a key={i} href={node.url} target="_blank" rel="noopener noreferrer">{children}</a>;
      case 'spoiler': if (preview) return <span key={i} className="chat-spoiler" aria-expanded="false">{children}</span>; return <button key={i} type="button" className="chat-spoiler" aria-label={t("Показать спойлер")} aria-expanded="false" onClick={event => { const button = event.currentTarget; const shown = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(shown)); button.setAttribute('aria-label', t(shown ? "Скрыть спойлер" : "Показать спойлер")); }}>{children}</button>;
      default: return <span key={i} className={`chat-markdown-${node.type}`} data-level={node.level} data-marker={node.marker && /^\d/.test(node.marker) ? node.marker : undefined}>{children || '\u00a0'}</span>;
    }
  });
}
function GifLink({url,source=url,mime}:{url:string;source?:string;mime?:string}) {
 const [failed,setFailed]=useState(false),[local,setLocal]=useState<{url:string;mime:string}>();
 const attempt=useRef({started:false,loading:false,mounted:true});
 useEffect(()=>{attempt.current.mounted=true;return()=>{attempt.current.mounted=false;};},[]);
 useEffect(()=>()=>{if(local)URL.revokeObjectURL(local.url);},[local]);
 const fallback=async()=>{
  if(attempt.current.loading)return;
  if(attempt.current.started){setFailed(true);return;}
  attempt.current.started=true;attempt.current.loading=true;
  try{
   const media=await membership<{mime:string;base64:string}|null>('gif.load',{url});
   if(!attempt.current.mounted)return;
   if(!media){setFailed(true);return;}
   const bytes=Uint8Array.from(atob(media.base64),char=>char.charCodeAt(0));
   setLocal({url:URL.createObjectURL(new Blob([bytes],{type:media.mime})),mime:media.mime});
  }catch{if(attempt.current.mounted)setFailed(true);}
  finally{attempt.current.loading=false;}
 };
 if(failed)return <a href={source} target="_blank" rel="noopener noreferrer">{source}</a>;
 const src=local?.url||url,type=local?.mime||mime;
 return type?.startsWith('video/')?<video className="member-chat-image chat-link-gif" src={src} autoPlay loop muted playsInline aria-label={t('GIF')} onError={()=>void fallback()}/>:<img className="member-chat-image chat-link-gif" src={src} referrerPolicy="no-referrer" alt={t('GIF')} onError={()=>void fallback()}/>;
}
function DeferredGif({source}:{source:string}){const [media,setMedia]=useState<{url:string;mime?:string}|null>(null);useEffect(()=>{let cancelled=false;const timer=setTimeout(()=>{void membership<{url:string;mime?:string}|null>('gif.resolve',{url:source}).then(result=>{if(!cancelled&&result?.url)setMedia(result);}).catch(()=>{});},150);return()=>{cancelled=true;clearTimeout(timer);};},[source]);return media?<GifLink url={media.url} source={source} mime={media.mime}/>:<a href={source} target="_blank" rel="noopener noreferrer">{source}</a>;}
export function MessageText({ text, preview = false, mentions=[],gif }: { text: string; preview?: boolean; mentions?:Mention[];gif?:{url:string;source:string;mime?:string} }) {
 let gifURL=gif?.source===text?gif.url:undefined;
 if(!preview&&!gifURL){
  try{
   const url=new URL(text.trim());
   if(url.protocol==='https:'&&!url.username&&!url.password&&/\.gif$/i.test(url.pathname))gifURL=url.href;
   else if(isGifProviderPage(url))return <DeferredGif key={url.href} source={url.href}/>;
  }catch{}
 }
 if(gifURL&&!preview)return <GifLink key={gifURL} url={gifURL} source={text} mime={gif?.mime}/>;
 return <>{render(messageMarkdown(text),preview,mentions.map(m=>text.slice(m.start,m.end)))}</>;
}
