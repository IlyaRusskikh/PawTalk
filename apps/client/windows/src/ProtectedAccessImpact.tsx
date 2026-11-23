import catalog from '../../../server/internal/access/catalog.json';
import { t, useLanguage } from './i18n';

type ScopeCounts = { visible: number; fullHistory: number };
export type GrantEvidence = { decision: string; permission: string; sources: {
  kind: 'owner' | 'administrator' | 'base' | 'channel' | 'category';
  effect: 'allow' | 'deny'; roleId?: string; roleName?: string;
}[] };
export type AccessImpact = {
  before: ScopeCounts & { allowed?: boolean; evidence?: GrantEvidence };
  after: ScopeCounts & { allowed?: boolean; evidence?: GrantEvidence };
  gained: ScopeCounts;
  lost: ScopeCounts;
};

export function ProtectedGrantSources({ evidence }: { evidence: GrantEvidence }) {
  const language = useLanguage();
  const grant = catalog.permissions.find(permission => permission.id === evidence.permission)?.[language] ?? evidence.permission;
  const labels = { owner: t('Полномочия владельца'), administrator: t('Право Administrator'), base: t('Право из роли'),
    channel: t('Правило канала'), category: t('Правило категории') };
  return <div>
    <p>{grant} · {evidence.decision === 'allowed' ? t('Доступно') : evidence.decision === 'timed_out' ? t('Действует тайм-аут') : t('Недоступно')}</p>
    {evidence.sources.length ? <ul>{evidence.sources.map((source, index) => <li key={`${source.kind}:${source.roleId ?? index}`}>
      {labels[source.kind]}{source.roleId
        ? ` · ${source.roleName ?? (source.roleId === '@everyone' ? t('Все участники') : source.roleId)}`
        : source.kind === 'category' || source.kind === 'channel' ? ` · ${t('Персональное правило')}` : ''}
      {' · '}{source.effect === 'allow' ? t('Разрешено') : t('Запрещено')}
    </li>)}</ul> : <p>{t('Разрешающее правило не найдено.')}</p>}
  </div>;
}

function GrantComparison({ before, after }: { before: GrantEvidence; after: GrantEvidence }) {
  return <div className="form-grid">
    <div><strong>{t('До изменения')}</strong><ProtectedGrantSources evidence={before}/></div>
    <div><strong>{t('После изменения')}</strong><ProtectedGrantSources evidence={after}/></div>
  </div>;
}

export function ProtectedAccessImpact({ impact }: { impact: AccessImpact }) {
  const { before, after, gained, lost } = impact;
  const status = (allowed?: boolean) => allowed ? t('Доступно') : t('Недоступно');
  return <><dl>
    {before.allowed !== undefined && <>
      <dt>{t('Действие по выбранному праву')}</dt><dd>{status(before.allowed)} → {status(after.allowed)}</dd>
    </>}
    <dt>{t('Видимые каналы')}</dt>
    <dd>{before.visible} → {after.visible} (+{gained.visible}, −{lost.visible})</dd>
    <dt>{t('Каналы с полной историей')}</dt>
    <dd>{before.fullHistory} → {after.fullHistory} (+{gained.fullHistory}, −{lost.fullHistory})</dd>
  </dl>{before.evidence && after.evidence && <GrantComparison before={before.evidence} after={after.evidence}/>}</>;
}

type Profile = { id: string; name?: string };
export type ChannelAccessDelta = {
  gainedView: Profile[]; lostView: Profile[]; gainedHistory: Profile[]; lostHistory: Profile[]; keyChannels: number;
};

export function ProtectedChannelAccessDelta({ impact }: { impact: ChannelAccessDelta }) {
  const groups = [
    [t('Получат доступ к каналам'), impact.gainedView],
    [t('Потеряют доступ к каналам'), impact.lostView],
    [t('Получат полную историю'), impact.gainedHistory],
    [t('Потеряют полную историю'), impact.lostHistory],
  ] as const;
  return <div className="form-fields">
    {groups.every(([, profiles]) => profiles.length === 0) && <p>{t('Видимость и доступ к истории сохранятся.')}</p>}
    {groups.filter(([, profiles]) => profiles.length > 0).map(([label, profiles]) => <details key={label}>
      <summary>{label} · {profiles.length}</summary>
      <ul>{profiles.map(profile => <li key={profile.id}>{profile.name ?? t('Участник · {0}', profile.id.slice(0, 8))}</li>)}</ul>
    </details>)}
    {impact.keyChannels > 0 && <p>{t('Текстовых каналов, для которых потребуется обновить ключи — {0}', impact.keyChannels)}</p>}
  </div>;
}

export type RoleAccessImpact = {
  keyChannels: number;
  changedChannels: number;
  details: {
    id: string; name?: string; beforeView: number; afterView: number; beforeHistory: number; afterHistory: number;
    example?: { profile: Profile; removedDeny: boolean; before: GrantEvidence; after: GrantEvidence };
  }[];
  administrator: { added: number; ready: number; removed: number };
};

export type ScopedRoleImpact = { id: string; keyUpdate: boolean; viewAdded: number; viewRemoved: number;
  fullHistoryAdded: number; fullHistoryRemoved: number }[];

export function ProtectedScopedRoleImpact({ impact, channelNames }: { impact: ScopedRoleImpact; channelNames?: Map<string, string> }) {
  const keyChannels = impact.filter(channel => channel.keyUpdate).length;
  return <div className="form-fields">
    {impact.length === 0 ? <p>{t('В видимых каналах доступ и история сохранятся.')}</p> : <>
      <p>{t('Видимых каналов с изменением доступа — {0}', impact.length)}</p>
      {impact.map((channel, index) => <details key={channel.id} open={index === 0 || undefined}>
        <summary>{channelNames?.get(channel.id) ?? t('Канал · {0}', channel.id.slice(0, 8))}</summary>
        <p>{t('Доступ к каналу: получат — {0}, потеряют — {1}.', channel.viewAdded, channel.viewRemoved)}</p>
        {(channel.fullHistoryAdded > 0 || channel.fullHistoryRemoved > 0) &&
          <p>{t('Полная история: получат — {0}, потеряют — {1}.', channel.fullHistoryAdded, channel.fullHistoryRemoved)}</p>}
      </details>)}
    </>}
    {keyChannels > 0 && <p>{t('Текстовых каналов, для которых потребуется обновить ключи — {0}', keyChannels)}</p>}
  </div>;
}

export function ProtectedRoleAccessImpact({ impact }: { impact: RoleAccessImpact }) {
  const { administrator, changedChannels, details, keyChannels } = impact;
  return <div className="form-fields">
    {administrator.added > 0 && <p>{t('Получат Administrator — {0}; восстановление настроено у {1}.', administrator.added, administrator.ready)}</p>}
    {administrator.removed > 0 && <p>{t('Потеряют Administrator — {0}.', administrator.removed)}</p>}
    {changedChannels === 0 ? <p>{t('Видимость и доступ к истории сохранятся.')}</p> : <>
      <p>{t('Каналов с изменением доступа — {0}', changedChannels)}</p>
      {details.map((channel, index) => <details key={channel.id} open={index === 0 || undefined}>
        <summary>{channel.name ?? t('Канал · {0}', channel.id.slice(0, 8))}</summary>
        <div className="form-fields">
          <p>{t('Участники с доступом к каналу: {0} → {1}', channel.beforeView, channel.afterView)}</p>
          {(channel.beforeHistory > 0 || channel.afterHistory > 0) &&
            <p>{t('Участники с полной историей: {0} → {1}', channel.beforeHistory, channel.afterHistory)}</p>}
          {channel.example && <>
            <p>{channel.example.profile.name ?? t('Участник · {0}', channel.example.profile.id.slice(0, 8))}</p>
            {channel.example.removedDeny && <p>{t('Удаление запрета роли откроет доступ.')}</p>}
            <GrantComparison before={channel.example.before} after={channel.example.after}/>
          </>}
        </div>
      </details>)}
      {changedChannels > details.length && <p>{t('Показано каналов — {0} из {1}', details.length, changedChannels)}</p>}
    </>}
    {keyChannels > 0 && <p>{t('Текстовых каналов, для которых потребуется обновить ключи — {0}', keyChannels)}</p>}
  </div>;
}
