import { useId, type ReactNode } from 'react';
import { Icon } from './Controls';
import { t } from './i18n';

export function MemberRosterPanel({ open, toggle, children, scoped = false }: {
  open: boolean; toggle(): void; children: ReactNode; scoped?: boolean;
}) {
  const id = useId();
  const label = t(open ? 'Скрыть список участников' : 'Показать список участников');
  return <>
    <button className="icon-button member-roster-toggle" type="button" title={label} aria-label={label}
      aria-expanded={open} aria-controls={id} onClick={toggle}><Icon name="users"/></button>
    <div className="member-roster-drawer" data-open={open} inert={!open}>
      <aside id={id} className={`member-roster${scoped ? ' protected-channel-roster' : ''}`}
        aria-label={t(scoped ? 'Участники канала' : 'Участники')}>
        {children}
      </aside>
    </div>
  </>;
}
