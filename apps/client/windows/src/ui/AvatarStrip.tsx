import { Children, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {createPortal} from 'react-dom';
import { t } from '../i18n';

export function AvatarStrip({ children, className, size, label, expandable = false }: { children: ReactNode; className: string; size: number; label?: string; expandable?: boolean }) {
  const element = useRef<HTMLDivElement>(null), [capacity, setCapacity] = useState(1);
  const [anchor,setAnchor]=useState<{left:number;top:number}>(), popup=useRef<HTMLDivElement>(null),closeTimer=useRef<ReturnType<typeof setTimeout>>(undefined),popupID=useId();
  const hide=()=>{clearTimeout(closeTimer.current);closeTimer.current=setTimeout(()=>setAnchor(undefined),120);};
  useEffect(()=>()=>clearTimeout(closeTimer.current),[]);
  useLayoutEffect(()=>{if(!anchor||!popup.current)return;const rect=popup.current.getBoundingClientRect();popup.current.style.top=Math.max(8,Math.min(anchor.top,innerHeight-rect.height-8))+'px';},[anchor,children]);
  const items = Children.toArray(children);
  useLayoutEffect(() => {
    const row = element.current!;
    const measure = () => {
      const style = getComputedStyle(row), gap = parseFloat(style.columnGap) || 0;
      const width = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      setCapacity(Math.max(1, Math.floor((width + gap) / (size + gap))));
    };
    const observer = new ResizeObserver(measure); observer.observe(row); measure();
    return () => observer.disconnect();
  }, [size]);
  const shown = items.length > capacity ? capacity - 1 : items.length, hidden = items.length - shown;
  return <><div ref={element} className={`${className} avatar-strip`} role={label ? 'list' : undefined} aria-label={label} style={{ '--avatar-strip-size': `${size}px` } as React.CSSProperties}>
    {items.slice(0, shown)}{hidden > 0 && <span className="avatar-strip-more" role="listitem" tabIndex={expandable?0:undefined} aria-describedby={anchor?popupID:undefined} onMouseEnter={event=>{if(expandable){clearTimeout(closeTimer.current);const r=event.currentTarget.getBoundingClientRect();setAnchor({left:Math.max(8,Math.min(r.left,innerWidth-296)),top:r.bottom+6});}}} onMouseLeave={hide} onFocus={event=>{if(expandable){const r=event.currentTarget.getBoundingClientRect();setAnchor({left:Math.max(8,Math.min(r.left,innerWidth-296)),top:r.bottom+6});}}} onBlur={hide} onKeyDown={event=>{if(event.key==='Escape')setAnchor(undefined);}} title={t('Ещё участников: {0}', hidden)} aria-label={t('Ещё участников: {0}', hidden)}>+{hidden}</span>}
  </div>{anchor&&createPortal(<div ref={popup} id={popupID} className="avatar-strip-popover" role="tooltip" style={{...anchor,'--avatar-strip-size':`${size}px`} as React.CSSProperties} onMouseEnter={()=>clearTimeout(closeTimer.current)} onMouseLeave={hide}>{items}</div>,document.body)}</>;
}
