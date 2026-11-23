import { useState } from 'react';
import catalog from '../../../server/internal/access/catalog.json';
import { permissionFitsACL } from '../../../../shared/protected-access.mjs';
import { t, useLanguage } from './i18n';

export type PermissionChoice = 'deny' | 'inherit' | 'allow';
const options = [
  { value: 'deny', label: 'Запретить', symbol: '×' },
  { value: 'inherit', label: 'Наследовать', symbol: '/' },
  { value: 'allow', label: 'Разрешить', symbol: '✓' },
] as const;

export function ProtectedPermissionRows({ kind, disabled, explicitViewOnly, ruleFor, onChange }: {
  kind: 'text' | 'voice' | 'category'; disabled: boolean; explicitViewOnly?: boolean;
  ruleFor(permission: string): PermissionChoice;
  onChange(permission: string, rule: PermissionChoice): void;
}) {
  const language = useLanguage();
  const [filter, setFilter] = useState('');
  const permissions = catalog.permissions.filter(item => permissionFitsACL(item.id, kind) &&
    (!explicitViewOnly || item.id === 'channel.view') &&
    item[language].toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return <div className="protected-permission-rows">
    <input type="search" aria-label={t('Поиск по правам')} placeholder={t('Поиск по правам')}
      value={filter} onChange={event => setFilter(event.target.value)}/>
    {permissions.map(item => <div className="protected-permission-row" key={item.id} data-permission={item.id}>
      <strong>{item[language]}</strong>
      <div className="protected-rule-segments" role="group" aria-label={item[language]}>
        {options.map(({ value, label, symbol }) => <button key={value} type="button" data-rule={value}
          aria-label={t(label)} title={t(label)} aria-pressed={ruleFor(item.id) === value}
          disabled={disabled || explicitViewOnly && value === 'deny'}
          onClick={() => onChange(item.id, value)}>{symbol}</button>)}
      </div>
    </div>)}
  </div>;
}
