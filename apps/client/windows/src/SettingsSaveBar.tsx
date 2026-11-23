import { t } from './i18n';
import { Button } from './ui/Button';

export function SettingsSaveBar({ busy, canSave = true, onReset, onSave }: {
  busy?: boolean; canSave?: boolean; onReset(): void; onSave(): void;
}) {
  return <div className="settings-save-bar">
    <span role="status">{t('Есть несохранённые изменения')}</span>
    <div className="modal-actions settings-save-actions">
      <Button variant="secondary" disabled={busy} onClick={onReset}>{t('Сбросить')}</Button>
      <Button disabled={busy || !canSave} onClick={onSave}>{t('Сохранить изменения')}</Button>
    </div>
  </div>;
}
