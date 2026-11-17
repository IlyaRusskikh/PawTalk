import {useRef, useState, useId} from 'react';
import {Modal} from './Modal';
import {membership} from './membership';
import {pollDurations, validatePoll} from '../shared/polls.mjs';
import {t} from './i18n';

export function PollDialog({serverId, channelId, onClose, onPosted}: {serverId: string; channelId: string; onClose(): void; onPosted(): Promise<void>}) {
  const [question, setQuestion] = useState(''), [options, setOptions] = useState(['', '']);
  const [duration, setDuration] = useState(86400), [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(true), [intermediate, setIntermediate] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const formId=useId();
  const pending = useRef<{signature: string; id: string}|undefined>(undefined);
  const valid = !!question.trim() && Array.from(question).length <= 300 && options.every(option => !!option.trim());
  async function publish() {
    if (busy || !valid) return;
    setBusy(true); setError('');
    try {
      const definition = validatePoll({options, duration, multiple, anonymous, intermediate});
      const signature = JSON.stringify({question: question.trim(), definition});
      if (pending.current?.signature !== signature) pending.current = {signature, id: crypto.randomUUID().replaceAll('-', '')};
      await membership('poll.create', {serverId, channelId, question: question.trim(), definition, requestId: pending.current!.id});
      await onPosted(); onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title={t('Создание опроса')} className="poll-dialog" footer={<div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</button><button form={formId} type="submit" className="primary" disabled={busy || !valid}>{t('Публикация')}</button></div>} onClose={() => {if (!busy) onClose();}}>
    <form id={formId} onSubmit={event => {event.preventDefault(); void publish();}}>
      <div className="form-fields">
        <label>{t('Вопрос')}<input autoFocus required maxLength={300} disabled={busy} placeholder={t('Какой вопрос вы хотите задать?')} value={question} onChange={event => setQuestion(event.target.value)}/><small className="poll-question-limit">{Array.from(question).length} / 300</small></label>
        <fieldset disabled={busy} className="poll-options"><legend>{t('Ответы')}</legend><div className="form-fields">
          {options.map((option, index) => <div className="poll-option-field" key={index}>
            <input required maxLength={100} aria-label={t('Ответ {0}', index + 1)} placeholder={t('Введите ответ (можно с эмодзи)')} value={option} onChange={event => setOptions(values => values.map((value, i) => i === index ? event.target.value : value))}/>
            <button type="button" className="icon-button" disabled={options.length <= 2} aria-label={t('Удалить ответ {0}', index + 1)} onClick={() => setOptions(values => values.filter((_, i) => i !== index))}>×</button>
          </div>)}
          <button type="button" className="poll-add-option" disabled={options.length >= 10} onClick={() => setOptions(values => [...values, ''])}>+ {t('Добавить еще один ответ')}</button></div>
        </fieldset>
        <label>{t('Срок')}<select disabled={busy} value={duration} onChange={event => setDuration(Number(event.target.value))}>{pollDurations.map((value, index) => <option key={value} value={value}>{[t('1 ч.'), t('4 ч.'), t('8 ч.'), t('24 ч.'), t('3 дня'), t('1 неделя'), t('2 недели')][index]}</option>)}</select></label>
        <div className="poll-settings">
          <label className="inline-check"><input type="checkbox" disabled={busy} checked={multiple} onChange={event => setMultiple(event.target.checked)}/>{t('Разрешить несколько ответов')}</label>
          <label className="inline-check"><input type="checkbox" disabled={busy} checked={anonymous} onChange={event => setAnonymous(event.target.checked)}/>{t('Анонимное голосование')}</label>
          <label className="inline-check"><input type="checkbox" disabled={busy} checked={intermediate} onChange={event => setIntermediate(event.target.checked)}/>{t('Показывать промежуточные результаты')}</label>
        </div>
      </div>
      {error && <p role="alert" className="text-error">{error}</p>}
      
    </form>
  </Modal>;
}
