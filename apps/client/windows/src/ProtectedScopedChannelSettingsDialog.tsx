import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from './i18n';
import { membership, type ProtectedServerState } from './membership';
import { Modal } from './Modal';
import { SettingsSaveBar } from './SettingsSaveBar';
import { Button } from './ui/Button';

type Channel = ProtectedServerState['channels'][number];
type Settings = NonNullable<Channel['settings']>;
type Proof = { channelId: string; kind: Channel['kind']; settings: Settings | null; policyHead: string; policyRevision: number };
type Draft = { name: string; description: string; count: string };
type Review = { settings: Settings; policyHead: string; policyRevision: number };
type Accepted = Review & { revision: number };
const emptyDraft = { name: '', description: '', count: '0' };
const maxDescriptionLength = 128 << 10;

function limit(kind: Channel['kind']) {
  return kind === 'text' ? 21600 : 0xffffffff;
}

function toDraft(kind: Channel['kind'], settings: Settings | null): Draft {
  if (!settings) return emptyDraft;
  return { name: settings.name, description: settings.description,
    count: String(kind === 'text' ? settings.slowmodeSeconds : settings.voiceCapacity) };
}

function validName(name: string) {
  return !!name && [...name].length <= 64 && !/[\p{Cc}\p{Cs}]/u.test(name);
}

function sameSettings(left: Settings, right: Settings | null) {
  return !!right && left.name === right.name && left.description === right.description &&
    left.slowmodeSeconds === right.slowmodeSeconds && left.voiceCapacity === right.voiceCapacity;
}

function proofError() {
  return t('Подтверждение настроек канала пока недоступно. Обновите его, чтобы продолжить.');
}

function settingsError(failure: unknown) {
  const code = (failure as { code?: string })?.code;
  if (code === 'PROTECTED_POLICY_CHANGED') return t('Политика доступа изменилась. Обновите подтверждение и проверьте черновик.');
  if (code === 'PROTECTED_ACCESS_DENIED') return t('Право изменять настройки этого канала недоступно.');
  return proofError();
}

export function ProtectedScopedChannelSettingsDialog({ serverId, channel, canEdit, navigation, onClose, onConfirmed }: {
  serverId: string; channel: Channel; canEdit: boolean; navigation: ReactNode; onClose(): void; onConfirmed(): void;
}) {
  const [proof, setProof] = useState<Proof>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState<Accepted>();
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mustRefresh, setMustRefresh] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const isMounted = useRef(false);
  const running = useRef(false);
  const text = channel.kind === 'text';

  async function readProof() {
    const result = await membership<Proof>('channel.settings.protected.read', { serverId, channelId: channel.id });
    if (result?.channelId !== channel.id || result.kind !== channel.kind || typeof result.policyHead !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.policyHead) || !Number.isSafeInteger(result.policyRevision) || result.policyRevision < 1 ||
      (result.settings !== null && (!result.settings || typeof result.settings.name !== 'string' ||
        !validName(result.settings.name) || typeof result.settings.description !== 'string' ||
        !Number.isSafeInteger(result.settings.slowmodeSeconds) || result.settings.slowmodeSeconds < 0 ||
        result.settings.slowmodeSeconds > (text ? limit('text') : 0) ||
        !Number.isSafeInteger(result.settings.voiceCapacity) || result.settings.voiceCapacity < 0 ||
        result.settings.voiceCapacity > (text ? 0 : limit('voice'))))) throw Error(proofError());
    return result;
  }

  async function fetchProof(current?: Proof, accepted?: Accepted) {
    const next = await readProof();
    if (!isMounted.current) return;
    if (accepted) {
      if (next.policyRevision < accepted.revision || next.policyHead === accepted.policyHead) return;
      if (sameSettings(accepted.settings, next.settings)) {
        setConfirmed(true);
        onConfirmed();
        return;
      }
      setPending(undefined);
      setConflict(true);
    }
    const previous = toDraft(channel.kind, current?.settings ?? null);
    const updated = toDraft(channel.kind, next.settings);
    setDraft(local => ({
      name: local.name === previous.name ? updated.name : local.name,
      description: local.description === previous.description ? updated.description : local.description,
      count: local.count === previous.count ? updated.count : local.count,
    }));
    setProof(next);
    setMustRefresh(false);
  }

  async function load() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fetchProof(proof, pending);
    } catch (failure) {
      if (isMounted.current && !pending) {
        setMustRefresh(true);
        setError(settingsError(failure));
      }
    } finally {
      running.current = false;
      if (isMounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    isMounted.current = true;
    void load();
    return () => { isMounted.current = false; };
  }, [serverId, channel.id]);

  async function save() {
    if (!proof || !canSave || running.current) return;
    const review = { settings, policyHead: proof.policyHead, policyRevision: proof.policyRevision };
    running.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const receipt = await membership<{ channelId: string; revision: number; confirmed?: boolean }>('channel.settings.protected.commit', {
        serverId, channelId: channel.id, policyHead: review.policyHead, settings: review.settings,
      });
      if (!isMounted.current) return;
      if (receipt?.channelId !== channel.id || !Number.isSafeInteger(receipt.revision) || receipt.revision <= review.policyRevision) {
        throw Error(proofError());
      }
      if (receipt.confirmed === true) {
        setConfirmed(true);
        onConfirmed();
        return;
      }
      const accepted = { ...review, revision: receipt.revision };
      setPending(accepted);
      await fetchProof(proof, accepted).catch(() => { /* The accepted change can be checked again once attested. */ });
    } catch (failure) {
      if (!isMounted.current) return;
      setMustRefresh(true);
      setError(settingsError(failure));
    } finally {
      running.current = false;
      if (isMounted.current) setBusy(false);
    }
  }

  const count = Number(draft.count);
  const name = draft.name.trim();
  const settings: Settings = { name, description: draft.description, slowmodeSeconds: text ? count : 0,
    voiceCapacity: text ? 0 : count };
  const original = toDraft(channel.kind, proof?.settings ?? null);
  const dirty = canEdit && !!proof && (draft.name !== original.name || draft.description !== original.description || draft.count !== original.count);
  const canSave = dirty && !!proof && !busy && !mustRefresh && validName(name) &&
    draft.description.length <= maxDescriptionLength && !/\p{Cs}/u.test(draft.description) && /^\d+$/.test(draft.count) &&
    count <= limit(channel.kind) && !sameSettings(settings, proof.settings);
  const canUpdate = !busy && canEdit && !!proof;
  const close = () => { if (!running.current) onClose(); };
  const countLabel = (value: Settings) => text ? t('Пауза между сообщениями — {0} с', value.slowmodeSeconds)
    : t('Лимит участников — {0}', value.voiceCapacity);

  return <Modal title={t('Обзор')} navigation={navigation} className="settings-modal protected-scoped-channel-settings" error={error}
    onClose={close} footer={confirmed || pending || mustRefresh ? <div className="modal-actions">
      {confirmed ? <Button onClick={close}>{t('Готово')}</Button>
        : <Button disabled={busy || !canEdit} onClick={() => void load()}>{t('Обновить подтверждение')}</Button>}
    </div> : dirty && <SettingsSaveBar busy={busy} canSave={canSave} onReset={() => setDraft(original)} onSave={() => void save()}/>}>
    {confirmed ? <p role="status">{t('Настройки канала обновлены и подтверждены.')}</p>
      : pending ? <p role="status">{t('Сервер принял изменение. Ожидается проверяемое подтверждение настроек.')}</p>
      : <div className="form-fields">
        {busy && !proof && <p role="status">{t('Проверяем настройки канала…')}</p>}
        {!canEdit && <p role="status">{t('Право изменять настройки этого канала недоступно.')}</p>}
        {conflict && <div role="status">
          <p>{t('После сохранения настройки канала изменились. Проверьте черновик и актуальные значения.')}</p>
          {proof?.settings && <div>
            <strong>{proof.settings.name}</strong>
            {text && proof.settings.description && <p>{proof.settings.description}</p>}
            <p>{countLabel(proof.settings)}</p>
          </div>}
        </div>}
        {proof && <>
          {proof.settings === null && <p>{t('У канала ещё нет подтверждённых настроек. Укажите название канала.')}</p>}
          <label>{t('Название канала')}<input value={draft.name} placeholder={proof.settings === null ? channel.name : undefined}
            required disabled={!canUpdate} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
          {text && <label>{t('Описание')}<textarea value={draft.description} rows={3} maxLength={maxDescriptionLength} disabled={!canUpdate}
            onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>}
          <label>{t(text ? 'Пауза между сообщениями (с)' : 'Лимит участников (0 — без ограничения)')}
            <input type="number" min={0} max={limit(channel.kind)} value={draft.count} disabled={!canUpdate}
              onChange={event => setDraft({ ...draft, count: event.target.value })}/>
          </label>
        </>}
      </div>}
  </Modal>;
}
