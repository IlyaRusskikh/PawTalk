import { t } from './i18n';

export function ProtectedOrderFields({ items, anchorId, after, disabled, onAnchor, onAfter }: {
  items: { id: string; name: string }[];
  anchorId: string;
  after: boolean;
  disabled: boolean;
  onAnchor(id: string): void;
  onAfter(after: boolean): void;
}) {
  return <>
    <label>{t('Относительно элемента')}<select value={anchorId} disabled={disabled} onChange={event => onAnchor(event.target.value)}>
      <option value="">{t('Выберите соседний элемент')}</option>
      {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <label>{t('Новое положение')}<select value={after ? 'after' : 'before'} disabled={disabled} onChange={event => onAfter(event.target.value === 'after')}>
      <option value="before">{t('Перед выбранным')}</option>
      <option value="after">{t('После выбранного')}</option>
    </select></label>
  </>;
}
