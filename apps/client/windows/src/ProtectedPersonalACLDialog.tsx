import { useEffect, useState, type ReactNode } from 'react';
import { t } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { SettingsSaveBar } from './SettingsSaveBar';
import { ProtectedPermissionRows } from './ProtectedPermissionRows';
import { Button } from './ui/Button';

type Rule = 'inherit' | 'allow' | 'deny';
type PersonalACL = { channelId: string; profileId: string; kind: 'voice' | 'text'; synchronized: boolean;
  revision: number; policyHead: string; rules: { Allow: string[] | null; Deny: string[] | null } | null };

export function ProtectedPersonalACLDialog({ serverId, channelId, profileId, profileName, navigation, onClose }: {
  serverId: string; channelId: string; profileId?: string; profileName?: string; navigation: ReactNode; onClose(): void;
}) {
  const [id, setId] = useState(profileId ?? '');
  const [target, setTarget] = useState(profileId ?? '');
  const [basis, setBasis] = useState<PersonalACL>();
  const [permission, setPermission] = useState('channel.view');
  const [choice, setChoice] = useState<Rule>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!target) return;
    let current = true;
    setBusy(true);
    void membership<PersonalACL>('channel.acl.protected.personal.read', { serverId, channelId, profileId: target }).then(value => {
      if (value?.channelId !== channelId || value.profileId !== target) throw Error('INVALID_API_RESPONSE');
      if (current) setBasis(value);
    }).catch(() => { if (current) setError(t('Персональные правила этого участника недоступны.')); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [serverId, channelId, target, attempt]);

  const oldRule = basis?.rules?.Allow?.includes(permission) ? 'allow' : basis?.rules?.Deny?.includes(permission) ? 'deny' : 'inherit';
  const rule = choice ?? oldRule;
  function load(next: string) {
    setTarget(next);
    setBasis(undefined);
    setError('');
    setAttempt(number => number + 1);
  }
  async function save() {
    if (!basis || busy || accepted || rule === oldRule) return;
    setBusy(true);
    setError('');
    try {
      const receipt = await membership<{ channelId: string; profileId: string; revision: number }>('channel.acl.protected.personal.commit', {
        serverId, channelId, profileId: target, policyHead: basis.policyHead, permission, rule,
      });
      if (receipt?.channelId !== channelId || receipt.profileId !== target || receipt.revision !== basis.revision + 1) throw Error('INVALID_API_RESPONSE');
      setAccepted(true);
    } catch (failure) {
      const code = (failure as { code?: string })?.code;
      if (code === 'PROTECTED_POLICY_CHANGED') load(target);
      else setError(code === 'PROTECTED_ACCESS_DENIED' ? t('Недостаточно прав для этого изменения.') : t('Не удалось сохранить правила доступа.'));
    } finally { setBusy(false); }
  }

  return <Modal title={t('Персональные правила доступа')} navigation={navigation} className={navigation ? 'settings-modal' : undefined} error={error} onClose={onClose}
    footer={!accepted && !!basis && rule !== oldRule && <SettingsSaveBar busy={busy}
      onReset={() => { setChoice(undefined); setError(''); }} onSave={() => void save()}/>}>
    {accepted ? <p role="status">{t('Изменение принято сервером. Новая политика проверяется.')}</p> : <div className="form-fields">
      {!profileId && <div className="field">
        <label>{t('Идентификатор профиля')}<input value={id} maxLength={64} onChange={event => setId(event.target.value)} disabled={busy} /></label>
        <Button disabled={busy || !/^[a-f0-9]{64}$/.test(id)} onClick={() => { setChoice(undefined); load(id); }}>
          {t('Проверить профиль')}
        </Button>
      </div>}
      {profileId && !basis && error && <Button onClick={() => load(target)}>{t('Обновить подтверждение')}</Button>}
      {!basis && busy && <p role="status">{t('Проверяем правила доступа…')}</p>}
      {basis && <>
        <strong>{target === profileId && profileName ? profileName : target}</strong>
        {basis.synchronized && <p>{t('После применения канал получит собственные правила.')}</p>}
        <ProtectedPermissionRows kind={basis.kind} disabled={busy}
          ruleFor={id => id === permission ? rule : basis.rules?.Allow?.includes(id) ? 'allow' :
            basis.rules?.Deny?.includes(id) ? 'deny' : 'inherit'}
          onChange={(id, value) => { setPermission(id); setChoice(value); }}/>
      </>}
    </div>}
  </Modal>;
}
