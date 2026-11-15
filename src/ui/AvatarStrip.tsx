import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';

export function AvatarStrip({ children, className, size, label }: { children: ReactNode; className: string; size: number; label?: string }) {
  const element = useRef<HTMLDivElement>(null), [capacity, setCapacity] = useState(1);
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
  return <div ref={element} className={`${className} avatar-strip`} role={label ? 'list' : undefined} aria-label={label} style={{ '--avatar-strip-size': `${size}px` } as React.CSSProperties}>
    {items.slice(0, shown)}{hidden > 0 && <span className="avatar-strip-more" role="listitem" title={t('Ещё участников: {0}', hidden)} aria-label={t('Ещё участников: {0}', hidden)}>+{hidden}</span>}
  </div>;
}
