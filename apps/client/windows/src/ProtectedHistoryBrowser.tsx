import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Controls';
import { ChatFile } from './ChatFile';
import { t } from './i18n';
import { membership, type ChatAttachment, type ChatImageAttachment } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import { VideoMessage } from './VideoMessage';
import { visualMime } from './mediaDraft';

type AttachmentGroup = { position: number; files?: ChatAttachment[]; image?: ChatImageAttachment };
type Match = AttachmentGroup & { sentAt: number; excerpt: string; names: string[] };
type Reference = AttachmentGroup & { text: string };
type Checkpoint = { first: number; cursor: string };
type Page = { matches: Match[]; next?: number; checkpoint: Checkpoint; retry?: false } | { retry: true };
type Snapshot = { version: number; query: string; rows: Match[]; next?: number; checkpoint: Checkpoint };
export type ProtectedHistoryMode = 'search' | 'gallery';

function Attachments({ serverId, channelId, entry }: { serverId: string; channelId: string; entry: AttachmentGroup }) {
  const files = [...(entry.files ?? [])];
  if (entry.image) files.unshift({ ...entry.image, name: entry.image.name ?? t('Изображение'), size: entry.image.size ?? 0 });
  const isVisual = (file: ChatAttachment) => visualMime(file.mime);
  const visual = files.filter(isVisual);
  const scope = { serverId, channelId, protectedPosition: entry.position };
  return <>
    {visual.length > 0 && <VideoMessage {...scope} files={visual}/>}
    {files.filter(file => !isVisual(file)).map(file => <ChatFile key={file.id} {...scope} file={file}/>)}
  </>;
}

export function ProtectedHistoryBrowser({ mode, serverId, channelId, version, searchTarget, close }: {
  mode: ProtectedHistoryMode; serverId: string; channelId: string; version: number; searchTarget?: HTMLElement; close(): void;
}) {
  const [text, setText] = useState('');
  const [request, setRequest] = useState<{ query: string }>();
  const [data, setData] = useState<Snapshot>();
  const [selected, setSelected] = useState<{ message: Reference; version: number; request: typeof request }>();
  const [status, setStatus] = useState<{ pending: boolean; error?: string }>({ pending: false });
  const serial = useRef(0);
  const visible = data?.version === version && data.query === (request?.query ?? '') ? data : undefined;
  const detail = selected?.version === version && selected.request === request ? selected.message : undefined;
  const title = t(mode === 'search' ? 'Поиск по сообщениям' : 'Галерея канала');

  async function load(query: string, previous?: Snapshot) {
    const token = ++serial.current;
    setStatus({ pending: true });
    setSelected(undefined);
    try {
      let after = previous?.next ?? 0;
      let checkpoint = previous?.checkpoint;
      let page: Page | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        page = await membership<Page>('chat.protected.browse', { serverId, channelId, mode, after, checkpoint,
          ...(mode === 'search' && { query }) });
        if (serial.current !== token) return;
        if (page.retry || page.matches.length || page.next === undefined) break;
        if (page.next <= after) throw Error('INVALID_PROTECTED_HISTORY_PAGE');
        after = page.next;
        checkpoint = page.checkpoint;
      }
      if (!page || page.retry) {
        setData(undefined);
        setStatus({ pending: false, error: t('История изменилась. Повторите поиск.') });
        return;
      }
      setData({ version, query, rows: [...(previous?.rows ?? []), ...page.matches], next: page.next, checkpoint: page.checkpoint });
      setStatus({ pending: false });
    } catch (error) {
      if (serial.current !== token) return;
      setData(undefined);
      setStatus({ pending: false, error: (error as Error).message });
    }
  }

  const loadFirstPage = useEffectEvent(() => {
    setData(undefined);
    setSelected(undefined);
    if (mode === 'gallery' || request) void load(request?.query ?? '');
  });
  useEffect(() => {
    loadFirstPage();
    return () => { serial.current++; };
  }, [mode, request, version, serverId, channelId]);

  async function open(position: number) {
    const token = ++serial.current;
    setStatus({ pending: true });
    setSelected(undefined);
    try {
      const message = await membership<Reference | undefined>('chat.protected.reference', { serverId, channelId, position });
      if (serial.current !== token) return;
      if (message?.position === position) {
        setSelected({ message, version, request });
        setStatus({ pending: false });
      } else {
        setData(previous => previous && ({ ...previous, rows: previous.rows.filter(row => row.position !== position) }));
        setStatus({ pending: false, error: t('Исходное сообщение уже недоступно.') });
      }
    } catch (error) {
      if (serial.current !== token) return;
      setData(undefined);
      setStatus({ pending: false, error: (error as Error).message });
    }
  }

  const searchForm = mode === 'search' && <form className="protected-history-search" onSubmit={event => {
      event.preventDefault();
      if (!text.trim()) return;
      setData(undefined);
      setRequest({ query: text.trim() });
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    }}>
      <input autoFocus type="search" aria-label={title} placeholder={title} maxLength={256} value={text}
        onChange={event => setText(event.target.value)}/>
      <button className="icon-button" type="submit" disabled={!text.trim()} aria-label={t('Найти')} title={t('Найти')}>
        <Icon name="search" size={16}/>
      </button>
    </form>;
  const results = <>
    {status.pending && <p role="status">{t('Загрузка…')}</p>}
    {detail && <section className="protected-history-original">
      <Button variant="quiet" onClick={() => setSelected(undefined)}>{t('Назад')}</Button>
      <p>{detail.text}</p>
      <Attachments serverId={serverId} channelId={channelId} entry={detail}/>
    </section>}
    {!detail && visible && <>
      <div className="protected-history-results">
        {visible.rows.map(row => <article key={row.position}>
          <Button variant="quiet" disabled={status.pending} onClick={() => void open(row.position)}>
            {t('Сообщение №{0}', row.position)}
          </Button>
          <time>{new Date(row.sentAt).toLocaleString()}</time>
          {row.excerpt && <p>{row.excerpt}</p>}
          {mode === 'search' && row.names.length > 0 && <p>{row.names.join(' · ')}</p>}
          {mode === 'gallery' && <Attachments serverId={serverId} channelId={channelId} entry={row}/>}
        </article>)}
      </div>
      {!visible.rows.length && visible.next === undefined && <p>{t(mode === 'search' ? 'Совпадений нет.' : 'В доступной истории нет вложений.')}</p>}
      {visible.next !== undefined && <Button variant="quiet" disabled={status.pending} onClick={() => void load(visible.query, visible)}>
        {t(mode === 'search' ? 'Продолжить поиск' : 'Загрузить ещё')}
      </Button>}
    </>}
    {mode === 'gallery' && !visible && status.error && <Button variant="quiet" onClick={() => void load('')}>{t('Повторить')}</Button>}
  </>;
  if (searchTarget && mode === 'search') return <>
    {createPortal(searchForm, searchTarget)}
    {request && <section className="protected-inline-search-results" aria-label={title}>
      {status.error && <p role="alert">{status.error}</p>}
      {results}
    </section>}
  </>;
  return <Modal title={title} onClose={close} error={status.error} className="protected-history-browser">
    {searchForm}{results}
  </Modal>;
}
