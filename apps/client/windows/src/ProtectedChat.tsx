import { Fragment, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from './Avatar';
import { AttachmentDrafts } from './AttachmentDrafts';
import { ChecklistDialog, type ChecklistContent } from './Checklist';
import { ChatFile } from './ChatFile';
import { ChatFileDrop } from './ChatFileDrop';
import { chatImageLimit } from './chatImages';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatComposerActivity, useChatComposerActivity } from './ChatComposerActivity';
import { useMessageHighlight } from './useMessageHighlight';
import { useProtectedProfileAppearances } from './useProtectedProfileAppearances';
import { Icon } from './Controls';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { t } from './i18n';
import { MessageText } from './MessageText';
import { MessageTime } from './MessageTime';
import { dropProtectedMemberMention, memberDragType } from './memberMention';
import { membership, type ChatAttachment, type ChatImageAttachment } from './membership';
import { FormattingTextarea } from './FormattingTextarea';
import { animateSendFlight, composerTextOrigin } from './sendFlight';
import { trimMessage } from './trimMessage';
import { Modal } from './Modal';
import { ProtectedChecklist } from './ProtectedChecklist';
import { ProtectedMentionTextarea } from './ProtectedMentionTextarea';
import type { ProtectedMention } from '../../../../shared/mentions.mjs';
import { messagePreview } from '../../../../shared/chat-format.mjs';
import { ProtectedPoll, type ProtectedPollDefinition } from './ProtectedPoll';
import type { DeferredPolicy, ProtectionStatus } from './ProtectedTextStatus';
import { PollDialog } from './PollDialog';
import { Button } from './ui/Button';
import { allocateMediaViews, createMediaDraft, disposeDraft, canPrepareAttachment, fitChatAttachment, hasGalleryPreview, largeAttachmentLimit, imageMime, prepareDraft, videoMime, visualMime, type MediaDraft } from './mediaDraft';
import { VoiceComposer, type VoiceDraft } from './VoiceComposer';

type ReadableMessage = { locked?: false; sentAt: number; editedAt?: number; own: boolean; authorProfileId?: string; canEdit?: boolean;
  dedicatedDeletion?: boolean; completedPoll?: boolean; text: string; replyTo?: number | null;
  mentions?: ProtectedMention[];
  checklist?: { everyone: boolean; items: { id: string; text: string }[] }; poll?: ProtectedPollDefinition;
  pollResult?: { winners: string[] }; files?: ChatAttachment[]; image?: ChatImageAttachment };
function continuesMessage(message: ReadableMessage, previous?: ReadableMessage) {
  return !!previous && !message.poll && !previous.poll && !message.pollResult && !previous.pollResult &&
    message.replyTo === undefined && (message.authorProfileId ? message.authorProfileId === previous.authorProfileId : message.own && previous.own) &&
    message.sentAt >= previous.sentAt && message.sentAt - previous.sentAt <= 300_000 &&
    new Date(message.sentAt).toDateString() === new Date(previous.sentAt).toDateString();
}

type ProtectedMessage = { position: number; revision?: number; originalPollPosition?: number } & ({ locked: true } | ReadableMessage);
type HistoryWindow = { first: number; last?: number; cursor: string; canDeleteOther: boolean; canDeletePoll?: boolean;
  canCreateList?: boolean; canCreatePoll?: boolean; canSend: boolean; canAttach?: boolean; canSendVoice?: boolean;
  removed: number[]; edits: { position: number; revision: number }[]; more?: boolean; pins?: PinPage };
type PinPage = { items: { position: number; revision: number }[]; canPin: boolean; next?: number };
type ProtectedPage = HistoryWindow & { messages: ProtectedMessage[]; next?: number; retry?: boolean };
const historyPageSize = 32;
const unreadContextSize = 12;
export type ProtectedChatCache = Map<string, {
  until: number; window: HistoryWindow; messages: ProtectedMessage[]; last: number; more: boolean; olderBoundary?: number;
  scrollTop: number; following: boolean;
}>;
type DeferredText = { basis: DeferredPolicy; replyTo?: number };
export type ProtectedDraft = { text: string; operationId: string; mentions?: ProtectedMention[]; deferred?: DeferredText };
type EditDraft = ProtectedDraft & { position: number; expectedRevision: number; originalText: string };
type EditChecklist = ChecklistContent & { position: number; expectedRevision: number };

type ProtectedChatProps = {
  serverId: string;
  channelId: string;
  channelName: string;
  cache: ProtectedChatCache;
  cacheKey: string;
  authorNames?: ReadonlyMap<string, { name: string; avatar?: string; color?: string }>;
  roleColors?: ReadonlyMap<string, string>;
  authorRosterCursor?: { after: string; revision: number };
  ownProfileId: string;
  ownAvatar?: string;
  draft?: ProtectedDraft;
  timedOut?: boolean;
  eventsLive?: boolean;
  composerEvents?: boolean;
  mediaVariants?: boolean;
  offline?: boolean;
  keysPending?: boolean;
  pauseSending?: boolean;
  protection?: ProtectionStatus;
  changeDraft: (text: string, mentions?: ProtectedMention[]) => void;
  onRead?: (position: number) => void;
  clearDraft: (operationId: string) => void;
  setDeferred: (operationId: string, deferred?: DeferredText) => void;
};

const isAccessDenied = (failure: unknown) => ['PROTECTED_ACCESS_DENIED', 'NOT_A_MEMBER', 'BANNED']
  .includes((failure as { code?: string }).code ?? '');
const newOperation = () => crypto.randomUUID().replaceAll('-', '');

function pinnedMessagePreview(message: ReadableMessage) {
  if (message.image) return t('Фото');
  for (const file of message.files ?? []) {
    if (file.mime.startsWith('image/')) return t('Фото');
    if (file.mime.startsWith('video/')) return t('Видео');
    if (file.mime.startsWith('audio/')) return t('Голосовое сообщение');
  }
  return messagePreview(message.text) || t(message.files?.length ? 'Вложение' : 'Сообщение');
}

function pruneHistory(messages: ProtectedMessage[], first: number, removed: ReadonlySet<number>) {
  const unavailable = new Set(removed);
  for (const message of messages) {
    if (message.originalPollPosition !== undefined &&
        (message.originalPollPosition < first || removed.has(message.originalPollPosition))) unavailable.add(message.position);
  }
  return messages.filter(message => message.position >= first && !unavailable.has(message.position))
    .map(message => !message.locked && message.replyTo != null &&
      (message.replyTo < first || unavailable.has(message.replyTo)) ? { ...message, replyTo: null } : message);
}

function ProtectedChatFrame({ channelName, children }: { channelName: string; children: ReactNode }) {
  return <div className="member-content"><section className="member-chat" aria-label={channelName}>{children}</section></div>;
}

function ProtectedComposerLayout({ children }: { children: ReactNode }) {
  return <div className="chat-compose">{children}</div>;
}

export function ProtectedHistoryLoading({ keysPending = false }: { keysPending?: boolean }) {
  return <div className="protected-history-loading">
    <div role="status">
      <strong>{t(keysPending ? 'Синхронизируем защищённый доступ…' : 'Загружаем сообщения…')}</strong>
      {keysPending && <p>{t('Получаем доступ к каналу и ключи шифрования. История появится автоматически.')}</p>}
    </div>
    <div className="protected-history-skeleton" aria-hidden="true">
      {[0, 1, 2].map(row => <div className="protected-history-skeleton-row" key={row}>
        <span/><div><span/><span/></div>
      </div>)}
    </div>
  </div>;
}

export function ProtectedChatPreview({ channelName, canSend, canAttach }: {
  channelName: string; canSend: boolean; canAttach: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const placeholder = t('Написать в «{0}»', channelName);
  return <ProtectedChatFrame channelName={channelName}>
      <div className="member-history chat-stream protected-chat-stream" role="log" aria-label={t('Сообщения')}>
        <p className="member-empty">{t('В режиме предпросмотра история сообщений скрыта.')}</p>
      </div>
      <div className="member-composer chat-composer">
        {canSend ? <ProtectedComposerLayout>
          {canAttach && <div className="chat-attachment-control">
            <button type="button" className="chat-attach" disabled aria-label={t('Вложения')}><Icon name="plus" size={22}/></button>
          </div>}
          <div className="chat-input-shell protected-chat-input-shell" data-preview={showPreview}>
            <button type="button" className="chat-preview-toggle icon-button" aria-pressed={showPreview}
              aria-label={t('Предпросмотр')} onClick={() => setShowPreview(value => !value)}><Icon name="eye" size={18}/></button>
            <textarea rows={1} aria-label={placeholder} placeholder={placeholder} maxLength={4096} value={draft}
              onChange={event => setDraft(event.target.value)}/>
            {showPreview && <div className="chat-compose-preview member-message-text">
              <MessageText text={draft} preview allowRemotePreview={false}/>
            </div>}
          </div>
          <button type="button" className="icon-button protected-chat-submit" disabled aria-label={t('Отправить')}><Icon name="send" size={18}/></button>
        </ProtectedComposerLayout> : <div className="protected-chat-preview-locked"><Icon name="lock" size={18}/>
          <span>{t('У роли нет права отправлять сообщения.')}</span></div>}
      </div>
  </ProtectedChatFrame>;
}

export function ProtectedChat({ serverId, channelId, channelName, cache, cacheKey, authorNames, roleColors, authorRosterCursor, ownProfileId, ownAvatar, draft, timedOut, eventsLive, composerEvents, mediaVariants = false, offline = false, keysPending = false, pauseSending, protection, changeDraft, clearDraft, setDeferred, onRead }: ProtectedChatProps) {
  const [cached] = useState(() => {
    const entry = cache.get(cacheKey);
    return !offline && !keysPending && entry && entry.until > Date.now() ? entry : undefined;
  });
  const [messages, setMessages] = useState<ProtectedMessage[]>(cached?.messages ?? []);
  const remainingAuthors = useMemo(() => messages.flatMap(message =>
    !message.locked && message.authorProfileId && authorRosterCursor && message.authorProfileId > authorRosterCursor.after
      ? [message.authorProfileId] : []), [messages, authorRosterCursor]);
  const additionalAuthors = useProtectedProfileAppearances(authorRosterCursor ? serverId : undefined,
    channelId, remainingAuthors, false, authorRosterCursor);
  const [hasMore, setHasMore] = useState(cached?.more ?? false);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [retryMessage, setRetryMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [outgoing, setOutgoing] = useState<ReadableMessage & { position?: number }>();
  const flightOrigin = useRef<ReturnType<typeof composerTextOrigin>>(undefined);
  const flightTarget = useRef<HTMLDivElement>(null);
  const flightCleanup = useRef<ReturnType<typeof animateSendFlight>>(undefined);
  const [flightActive, setFlightActive] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const attachmentButton = useRef<HTMLButtonElement>(null);
  const [canDeleteOther, setCanDeleteOther] = useState(cached?.window.canDeleteOther ?? false);
  const [canDeletePoll, setCanDeletePoll] = useState(cached?.window.canDeletePoll ?? false);
  const [sendGranted, setCanSend] = useState(cached?.window.canSend ?? false);
  const [historyConfirmed, setHistoryConfirmed] = useState(!!cached && !!eventsLive);
  const [openedAt] = useState(() => performance.now());
  const reportedOpen = useRef(false);
  useEffect(() => {
    if (offline || !historyConfirmed || reportedOpen.current) return;
    const frame = requestAnimationFrame(() => {
      reportedOpen.current = true;
      window.desktop?.recordClientPerformance?.('chat.open.rendered', performance.now() - openedAt);
    });
    return () => cancelAnimationFrame(frame);
  }, [offline, historyConfirmed, openedAt]);
  const preparingAccess = keysPending && !historyConfirmed;
  const readOnly = offline || !historyConfirmed;
  const loadingHistory = !offline && (preparingAccess || (!historyConfirmed && !readError && !retryMessage));
  const canSend = sendGranted && !pauseSending && !readOnly && (!keysPending || protection?.allowSend === true);
  const [canAttach, setCanAttach] = useState(cached?.window.canAttach ?? false);
  const [canSendVoice, setCanSendVoice] = useState(cached?.window.canSendVoice ?? false);
  const [attachments, setAttachments] = useState<MediaDraft[]>([]);
  const attachmentDrafts = useRef<MediaDraft[]>([]);
  const fittingFiles = useRef<AbortController>(undefined);
  const canAttachFiles = useRef(false);
  const [fitting, setFitting] = useState(false);
  const [fileOperation, setFileOperation] = useState(newOperation);
  const [recording, setRecording] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const canPublishActivity = !!composerEvents && !!eventsLive && !readOnly && !timedOut;
  const composerActivity = useChatComposerActivity(serverId, channelId, canPublishActivity,
    recording && recordingActive && canSendVoice);
  const picker = useRef<HTMLInputElement>(null);
  const voiceOperation = useRef<{ file: File; id: string } | undefined>(undefined);
  const preparedMedia = useRef(new Map<string, Promise<Pick<MediaDraft, 'poster' | 'view' | 'duration'> | undefined>>());
  const activeSend = useRef(false);
  const sendingPaused = useRef(pauseSending || readOnly);
  sendingPaused.current = pauseSending || readOnly;
  const [canCreateList, setCanCreateList] = useState(cached?.window.canCreateList ?? false);
  const [creatingList, setCreatingList] = useState(false);
  const [canCreatePoll, setCanCreatePoll] = useState(cached?.window.canCreatePoll ?? false);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const [replyTo, setReplyTo] = useState<number>();
  const [editing, setEditing] = useState<EditDraft>();
  const [editingChecklist, setEditingChecklist] = useState<EditChecklist>();
  const [editError, setEditError] = useState('');
  const [deleting, setDeleting] = useState<number>();
  const [messageMenu, setMessageMenu] = useState<{ position: number; x: number; y: number; anchor: HTMLElement }>();
  const [mutating, setMutating] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [pins, setPins] = useState(cached?.window.pins);
  const [pinPreview, setPinPreview] = useState<{ position: number; revision: number; text: string }>();
  const mounted = useRef(false);
  const availability = useRef({ offline, keysPending });
  if (availability.current.offline !== offline || availability.current.keysPending !== keysPending) {
    availability.current = { offline, keysPending };
  }
  const reading = useRef(false);
  const last = useRef(cached?.last ?? 0);
  const olderBoundary = useRef(cached?.olderBoundary);
  const readKey = 'pawtalk.v3.read.' + cacheKey;
  const lastSeen = useRef(Number(localStorage.getItem(readKey)) || 0);
  const [seenPosition, setSeenPosition] = useState(lastSeen.current);
  const [newestPosition, setNewestPosition] = useState(0);
  const [aboveLatest, setAboveLatest] = useState(false);
  const [unreadMarker, setUnreadMarker] = useState<{ position: number; closing: boolean }>();
  const initialUnread = useRef<number | undefined>(undefined);
  const first = useRef(cached?.window.first);
  const cursor = useRef(cached?.window.cursor);
  const locallyRemoved = useRef(new Set<number>());
  const [initialVersions] = useState(() => new Map(cached?.messages.map(message => [message.position, message.revision ?? 1])));
  const versions = useRef(initialVersions);
  const pendingEdits = useRef(new Map<number, number>());
  const hasMoreRef = useRef(cached?.more ?? false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const following = useRef(cached?.following ?? true);
  const scrollTop = useRef(cached?.scrollTop ?? 0);
  const restoreScroll = useRef(!!cached && !cached.following);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryAt = useRef(0);
  const confirmedUntil = useRef(cached?.until ?? 0);
  const cacheInvalidation = useRef(0);
  const needsCachedValidation = useRef(!!cached && !eventsLive);
  const messageNodes = useRef(new Map<number, HTMLElement>());
  const resizePosition = useRef<{ width: number; height: number; anchor?: { position: number; bottom: number } }>(undefined);
  function rememberResizePosition(list: HTMLDivElement) {
    const viewport = list.getBoundingClientRect();
    let anchor: { position: number; bottom: number } | undefined;
    for (const [position, row] of messageNodes.current) {
      const bounds = row.getBoundingClientRect();
      const bottom = bounds.bottom - viewport.bottom;
      if (bounds.top < viewport.bottom && bounds.bottom > viewport.top && (!anchor || bottom > anchor.bottom)) {
        anchor = { position, bottom };
      }
    }
    resizePosition.current = { width: list.clientWidth, height: list.clientHeight, anchor };
  }
  const preservedScroll = useRef<{ position: number; top: number } | undefined>(undefined);
  const scrollTarget = useRef<number>(undefined);
  const scrollLatest = useRef(false);
  const queuedJump = useRef<number | 'latest'>(undefined);
  const latestJump = useRef(0);
  const highlight = useMessageHighlight();
  const revealMessage = (row: HTMLElement, smooth: boolean) => {
    const list = history.current;
    if (!list) return;
    const viewport = list.getBoundingClientRect();
    const target = row.getBoundingClientRect();
    if (target.top < viewport.top || target.bottom > viewport.top + list.clientHeight) {
      following.current = false;
      list.scrollTo({ top: list.scrollTop + target.top - viewport.top - (list.clientHeight - target.height) / 2,
        behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
    }
    highlight(row);
  };
  function rememberRead() {
    const list = history.current;
    if (!list || readOnly || !document.hasFocus() || document.hidden || document.querySelector('dialog[open]')) return;
    const bounds = list.getBoundingClientRect();
    let seen = Math.max(lastSeen.current, Number(localStorage.getItem(readKey)) || 0);
    for (const [position, row] of messageNodes.current) {
      if (row.getBoundingClientRect().bottom <= bounds.bottom + 2) seen = Math.max(seen, position);
    }
    if (seen > lastSeen.current) {
      lastSeen.current = seen;
      setSeenPosition(seen);
      localStorage.setItem(readKey, String(seen));
      onRead?.(seen);
    }
  }
  const followHistory = () => {
    const list = history.current;
    if (!list) return;
    const saved = preservedScroll.current;
    if (scrollTarget.current !== undefined) {
      const row = messageNodes.current.get(scrollTarget.current);
      scrollTarget.current = undefined;
      if (row) revealMessage(row, false);
    } else if (scrollLatest.current) {
      scrollLatest.current = false;
      smoothScrollToLatest(list);
    } else if (saved) {
      const row = messageNodes.current.get(saved.position);
      if (row) list.scrollTop += row.getBoundingClientRect().top - saved.top;
      preservedScroll.current = undefined;
    } else if (initialUnread.current !== undefined && messages.length) {
      const firstUnread = messages.find(message => message.position >= initialUnread.current!);
      if (firstUnread) {
        const row = messageNodes.current.get(firstUnread.position);
        const marker = row?.previousElementSibling;
        (marker?.classList.contains('chat-unread-divider') ? marker : row)?.scrollIntoView({ block: 'start' });
        initialUnread.current = undefined;
      }
    } else if (following.current) list.scrollTop = list.scrollHeight;
    scrollTop.current = list.scrollTop;
    setAboveLatest(list.scrollHeight - list.clientHeight - list.scrollTop >= 36);
  };
  useLayoutEffect(followHistory, [messages, historyConfirmed, outgoing, unreadMarker]);
  useLayoutEffect(() => {
    const list = history.current;
    if (!list) return;
    rememberResizePosition(list);
    const observer = new ResizeObserver(() => {
      const saved = resizePosition.current;
      if (!saved || !list.clientWidth || !list.clientHeight ||
          (saved.width === list.clientWidth && saved.height === list.clientHeight)) return;
      if (following.current) {
        list.scrollTop = list.scrollHeight;
      } else if (saved.anchor) {
        const row = messageNodes.current.get(saved.anchor.position);
        if (row) {
          const bounds = row.getBoundingClientRect();
          const offset = Math.max(1 - list.clientHeight, Math.min(saved.anchor.bottom, bounds.height - 1));
          list.scrollTop += bounds.bottom - list.getBoundingClientRect().bottom - offset;
        }
      }
      scrollTop.current = list.scrollTop;
      setAboveLatest(list.scrollHeight - list.clientHeight - list.scrollTop >= 36);
      const entry = cache.get(cacheKey);
      if (entry) entry.scrollTop = list.scrollTop;
      resizePosition.current = { ...saved, width: list.clientWidth, height: list.clientHeight };
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [cache, cacheKey]);
  useLayoutEffect(() => {
    const list = history.current;
    const previous = resizePosition.current;
    if (list && (!previous || (previous.width === list.clientWidth && previous.height === list.clientHeight))) {
      rememberResizePosition(list);
    }
  }, [messages, historyConfirmed, outgoing]);
  useEffect(() => {
    const record = () => rememberRead();
    record();
    window.addEventListener('focus', record);
    return () => window.removeEventListener('focus', record);
  }, [messages, historyConfirmed, offline, readKey]);
  const confirmedOutgoing = outgoing?.position !== undefined && last.current >= outgoing.position;
  useLayoutEffect(() => {
    if (confirmedOutgoing && !flightCleanup.current) setOutgoing(undefined);
    const origin = flightOrigin.current;
    if (!outgoing || !origin || !flightTarget.current || !history.current) return;
    flightOrigin.current = undefined;
    flightCleanup.current = animateSendFlight(history.current, flightTarget.current, origin, () => {
      flightCleanup.current = undefined;
      setFlightActive(false);
    });
    if (flightCleanup.current) setFlightActive(true);
  }, [confirmedOutgoing, outgoing, flightActive]);
  useEffect(() => () => flightCleanup.current?.(false), []);
  useLayoutEffect(() => {
    if (history.current && historyConfirmed && restoreScroll.current) {
      restoreScroll.current = false;
      history.current.scrollTop = scrollTop.current;
      rememberResizePosition(history.current);
    }
  }, [historyConfirmed]);
  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  useLayoutEffect(() => {
    if (readOnly || confirmedUntil.current <= Date.now() || pendingEdits.current.size ||
        first.current === undefined || cursor.current === undefined) return;
    if (messages.length > 256) {
      cache.delete(cacheKey);
      return;
    }
    const snapshot = {
      until: confirmedUntil.current, last: last.current, more: hasMore, olderBoundary: olderBoundary.current,
      messages, scrollTop: scrollTop.current, following: following.current,
      window: { first: first.current, cursor: cursor.current, removed: [], edits: [], pins,
        canDeleteOther, canDeletePoll, canSend: sendGranted, canAttach, canSendVoice, canCreateList, canCreatePoll },
    };
    cache.delete(cacheKey);
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, snapshot);
  }, [cache, cacheKey, cacheVersion, eventsLive, readOnly, messages, hasMore, pins,
    canDeleteOther, canDeletePoll, sendGranted, canAttach, canSendVoice, canCreateList, canCreatePoll]);
  const markPollClosed = useCallback((position: number) => {
    setMessages(messages => messages.map(message => message.position === position && !message.locked ?
      { ...message, completedPoll: true, dedicatedDeletion: true } : message));
  }, []);
  const applyWindow = useCallback((window: HistoryWindow) => {
    if (window.last !== undefined) setNewestPosition(window.last);
    const { first: nextFirst } = window;
    cursor.current = window.cursor;
    setCanDeleteOther(window.canDeleteOther);
    setCanDeletePoll(window.canDeletePoll === true);
    setCanSend(window.canSend);
    setCanAttach(window.canAttach === true);
    setCanSendVoice(window.canSendVoice === true);
    if (!window.canSendVoice) setRecording(false);
    setCanCreateList(window.canCreateList === true);
    setCanCreatePoll(window.canCreatePoll === true);
    setPins(window.pins);
    const removed = new Set(window.removed);
    if (removed.size) {
      for (const position of removed) {
        locallyRemoved.current.delete(position);
        pendingEdits.current.delete(position);
        versions.current.delete(position);
      }
    }
    setDeleting(position => position !== undefined && (position < nextFirst || removed.has(position)) ? undefined : position);
    setReplyTo(position => position !== undefined && (position < nextFirst || removed.has(position)) ? undefined : position);
    setEditing(draft => draft && (draft.position < nextFirst || removed.has(draft.position)) ? undefined : draft);
    setEditingChecklist(draft => draft && (draft.position < nextFirst || removed.has(draft.position)) ? undefined : draft);
    for (const { position, revision } of window.edits) {
      const loaded = versions.current.get(position);
      if (loaded !== undefined && revision > Math.max(loaded, pendingEdits.current.get(position) ?? 0)) {
        pendingEdits.current.set(position, revision);
      }
    }
    const previous = first.current;
    first.current = nextFirst;
    needsCachedValidation.current = false;
    setHistoryConfirmed(true);
    if (window.more || window.edits.length || removed.size || (previous !== undefined && previous !== nextFirst)) {
      confirmedUntil.current = 0;
      cache.delete(cacheKey);
    }
    if (removed.size || (previous !== undefined && nextFirst > previous)) {
      setMessages(messages => pruneHistory(messages, nextFirst, removed));
    }
    if (previous === undefined || previous === nextFirst) return false;
    if (nextFirst < previous) {
      last.current = 0;
      olderBoundary.current = undefined;
      setMessages([]);
      versions.current.clear();
      pendingEdits.current.clear();
    } else {
      for (const position of versions.current.keys()) {
        if (position >= nextFirst) continue;
        versions.current.delete(position);
        pendingEdits.current.delete(position);
      }
    }
    hasMoreRef.current = false;
    setHasMore(false);
    return true;
  }, [cache, cacheKey]);
  const readAgain = useRef(false);
  const load: (windowOnly?: boolean, older?: boolean, target?: number | 'latest') => Promise<void> = useCallback(async (windowOnly = false, older = false, target) => {
    const started = availability.current;
    const revision = cacheInvalidation.current;
    if (started.offline || retryAt.current > Date.now()) return;
    if (started.keysPending && first.current === undefined) windowOnly = false;
    if (reading.current) {
      if (target !== undefined) queuedJump.current = target;
      else if (!older) readAgain.current = true;
      return;
    }
    const jump = latestJump.current;
    const canApply = () => mounted.current && availability.current === started;
    reading.current = true;
    const scope = { serverId, channelId };
    const readWindow = () => membership<HistoryWindow>('chat.protected.window', { ...scope, cursor: cursor.current });
    const confirmCache = () => {
      if (!started.keysPending && revision === cacheInvalidation.current && !pendingEdits.current.size) {
        confirmedUntil.current = Date.now() + 30_000;
        setCacheVersion(value => value + 1);
      }
    };
    const refreshEditions = async () => {
      const replacements = new Map<number, ProtectedMessage>();
      for (const [position, expected] of [...pendingEdits.current].slice(0, 8)) {
        let updated: ProtectedMessage | undefined;
        try {
          updated = await membership<ProtectedMessage | undefined>('chat.protected.edition', { ...scope, position });
        } catch (failure) {
          if ((failure as { code?: string }).code === 'PROTECTED_REVISION_CHANGED') continue;
          throw failure;
        }
        if (!canApply()) return;
        if (!updated || updated.position !== position || (updated.revision ?? 0) < expected || locallyRemoved.current.has(position)) continue;
        replacements.set(position, updated);
        versions.current.set(position, updated.revision!);
        pendingEdits.current.delete(position);
      }
      if (replacements.size) setMessages(previous => previous.map(message => replacements.get(message.position) ?? message));
    };
    const clearHistory = () => {
      confirmedUntil.current = 0;
      cache.delete(cacheKey);
      first.current = undefined;
      cursor.current = undefined;
      locallyRemoved.current.clear();
      versions.current.clear();
      pendingEdits.current.clear();
      setHistoryConfirmed(false);
      setCanDeleteOther(false);
      setCanDeletePoll(false);
      setCanSend(false);
      setCanAttach(false);
      setCanSendVoice(false);
      setRecording(false);
      setCanCreateList(false);
      setCreatingList(false);
      setCanCreatePoll(false);
      setCreatingPoll(false);
      setPins(undefined);
      setReplyTo(undefined);
      setDeleting(undefined);
      setEditing(undefined);
      setEditingChecklist(undefined);
      setOutgoing(undefined);
      last.current = 0;
      olderBoundary.current = undefined;
      setMessages([]);
      setNewestPosition(0);
      setUnreadMarker(undefined);
      hasMoreRef.current = false;
      setHasMore(false);
    };
    try {
      let latestAfter: number | undefined;
      const hadHistory = olderBoundary.current !== undefined;
      if (target === 'latest') {
        const window = await readWindow();
        if (!canApply() || jump !== latestJump.current) return;
        applyWindow(window);
        latestAfter = Math.max(window.first - 1, (window.last ?? last.current) - historyPageSize);
      } else if (!windowOnly && !older && olderBoundary.current === undefined) {
        const window = await readWindow();
        if (!canApply()) return;
        if (started.keysPending && window.last !== undefined && window.last < window.first) return;
        const seen = lastSeen.current;
        const newest = window.last ?? 0;
        const unread = seen >= window.first - 1 && seen > 0 && seen < newest;
        const context = unread ? Math.min(unreadContextSize, Math.max(0, historyPageSize - (newest - seen))) : 0;
        if (unread) {
          following.current = false;
          initialUnread.current = seen + 1;
        }
        last.current = Math.max(window.first - 1, unread ? seen - context : newest - historyPageSize);
        olderBoundary.current = last.current;
        cursor.current = window.cursor;
      }
      if (windowOnly) {
        const window = await readWindow();
        if (!canApply()) return;
        clearTimeout(retryTimer.current);
        const changed = applyWindow(window);
        setRetryMessage('');
        setReadError('');
        await refreshEditions();
        if (canApply() && !window.more && !changed) confirmCache();
        if (window.more || !changed) return;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const boundary = older ? olderBoundary.current : undefined;
        if (older && (boundary === undefined || boundary < (first.current ?? 1))) return;
        const after = latestAfter ?? (typeof target === 'number' ? Math.max((first.current ?? 1) - 1, target - 1) :
          boundary === undefined ? last.current : Math.max((first.current ?? 1) - 1, boundary - historyPageSize));
        const limit = boundary === undefined ? undefined : boundary - after;
        const page = await membership<ProtectedPage>('chat.protected.read', { ...scope, after, cursor: cursor.current,
          ...(limit !== undefined && { limit }) });
        if (!canApply()) return;
        if (started.keysPending && first.current === undefined &&
            (page.retry || !page.messages.length || page.messages.some(message => message.locked))) return;
        clearTimeout(retryTimer.current);
        setRetryMessage('');
        const changed = applyWindow(page);
        if (target !== undefined && jump !== latestJump.current) return;
        if (target !== undefined && !page.retry) {
          const received = page.messages.filter(message => !locallyRemoved.current.has(message.position));
          if (typeof target === 'number' && !received.some(message => message.position === target && !message.locked)) {
            setReadError(t('Сообщение недоступно.'));
            return;
          }
          setReadError('');
          last.current = page.next ?? Math.max(received.at(-1)?.position ?? after, page.last ?? 0);
          olderBoundary.current = after;
          hasMoreRef.current = page.next !== undefined && (page.last === undefined || page.next < page.last);
          setHasMore(hasMoreRef.current);
          versions.current = new Map(received.map(message => [message.position, message.revision ?? 1]));
          pendingEdits.current.clear();
          following.current = false;
          scrollLatest.current = target === 'latest' && !hasMoreRef.current;
          initialUnread.current = undefined;
          preservedScroll.current = undefined;
          scrollTarget.current = typeof target === 'number' ? target : undefined;
          setMessages(received);
          confirmCache();
          return;
        }
        if (page.retry || boundary === undefined && last.current !== after || older && changed) continue;
        setReadError('');
        if (!older) {
          last.current = page.next ?? Math.max(last.current, page.messages.at(-1)?.position ?? 0, page.last ?? 0);
          hasMoreRef.current = page.next !== undefined && (page.last === undefined || page.next < page.last);
          setHasMore(hasMoreRef.current);
        } else olderBoundary.current = after;
        const received = page.messages.filter(message => (boundary === undefined || message.position <= boundary) &&
          !locallyRemoved.current.has(message.position));
        if (!older && (hadHistory || initialUnread.current !== undefined)) {
          const position = received.find(message => message.position > lastSeen.current && !message.locked && !message.own)?.position;
          if (position !== undefined) setUnreadMarker(marker => marker && !marker.closing ? marker : { position, closing: false });
        }
        for (const message of received) versions.current.set(message.position, message.revision ?? 1);
        if (received.length) {
          if (older && history.current) {
            const edge = history.current.getBoundingClientRect().top;
            const anchor = [...messageNodes.current].filter(([, node]) => node.getBoundingClientRect().bottom > edge)
              .sort(([left], [right]) => left - right)[0];
            if (anchor) preservedScroll.current = { position: anchor[0], top: anchor[1].getBoundingClientRect().top };
          }
          setMessages(previous => older ? [...received, ...previous] : [...previous, ...received]);
        }
        await refreshEditions();
        if (canApply()) confirmCache();
        return;
      }
    } catch (failure) {
      if (!canApply()) return;
      const { code, retryAfter } = failure as { code?: string; retryAfter?: number };
      if (code === 'RATE_LIMIT') {
        setRetryMessage((failure as Error).message);
        clearTimeout(retryTimer.current);
        const delay = (retryAfter ?? 60) * 1000;
        retryAt.current = Date.now() + delay;
        retryTimer.current = setTimeout(() => {
          retryAt.current = 0;
          if (mounted.current && (target === undefined || latestJump.current === jump)) void load(windowOnly, older, target);
        }, delay);
        return;
      }
      setRetryMessage('');
      if (isAccessDenied(failure)) {
        clearHistory();
      } else if (!windowOnly && (!started.keysPending || first.current !== undefined)) {
        // An import or key can stop opening before the page reaches the final
        // window check. Reconcile existing plaintext independently of keys.
        try {
          const window = await readWindow();
          if (canApply()) applyWindow(window);
        } catch (windowError) {
          if (canApply() && isAccessDenied(windowError)) clearHistory();
        }
      }
      if (canApply()) setReadError((failure as Error).message);
    } finally {
      reading.current = false;
      const nextJump = queuedJump.current;
      queuedJump.current = undefined;
      if (nextJump !== undefined && mounted.current) {
        readAgain.current = false;
        queueMicrotask(() => { if (mounted.current) void load(false, false, nextJump); });
      } else if (readAgain.current && mounted.current) {
        readAgain.current = false;
        queueMicrotask(() => { if (mounted.current) void load(hasMoreRef.current); });
      }
    }
  }, [serverId, channelId, applyWindow, cache, cacheKey]);
  useEffect(() => {
    if (!offline) {
      if (keysPending) {
        confirmedUntil.current = 0;
        cache.delete(cacheKey);
        setReadError('');
      }
      if (needsCachedValidation.current || confirmedUntil.current <= Date.now()) {
        const timer = setTimeout(() => void load(needsCachedValidation.current), 50);
        return () => clearTimeout(timer);
      }
      return;
    }
    confirmedUntil.current = 0;
    cache.delete(cacheKey);
    setRetryMessage('');
    setHistoryConfirmed(false);
    setRecording(false);
    setCreatingPoll(false);
    setCreatingList(false);
    setEditingChecklist(undefined);
    setDeleting(undefined);
  }, [load, offline, keysPending, cache, cacheKey]);
  useEffect(() => {
    mounted.current = true;
    let chatRefresh: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.desktop?.onMembershipProtectedEvent?.(event => {
      if (event.serverId !== serverId || event.type === 'voice' || event.type === 'composer') return;
      if (event.type === 'chat') {
        if (event.channelId !== channelId) return;
        cacheInvalidation.current++;
        confirmedUntil.current = 0;
        if (event.pushed) {
          clearTimeout(chatRefresh);
          chatRefresh = undefined;
          void load(hasMoreRef.current);
          return;
        }
        if (chatRefresh) return;
        chatRefresh = setTimeout(() => {
          chatRefresh = undefined;
          void load(hasMoreRef.current);
        }, 50);
      } else if (event.type !== 'status' || !event.live) {
        cacheInvalidation.current++;
        confirmedUntil.current = 0;
        clearTimeout(chatRefresh);
        chatRefresh = undefined;
        void load(hasMoreRef.current);
      }
    });
    return () => { mounted.current = false; clearTimeout(chatRefresh); clearTimeout(retryTimer.current); unsubscribe?.(); };
  }, [load, serverId, channelId]);
  useEffect(() => {
    if (offline) return;
    const timer = setInterval(() => void load(hasMoreRef.current), eventsLive ? 30_000 : 5_000);
    return () => clearInterval(timer);
  }, [load, eventsLive, offline]);
  useEffect(() => () => {
    fittingFiles.current?.abort();
    attachmentDrafts.current.forEach(disposeDraft);
    attachmentDrafts.current = [];
    preparedMedia.current.clear();
  }, []);

  const deferred = draft?.deferred;
  const canAddAttachments = canAttach && !timedOut && !sending && !pauseSending && !readOnly && !deferred && !recording;
  canAttachFiles.current = canAddAttachments;
  function updateAttachments(items: MediaDraft[]) {
    attachmentDrafts.current = items;
    setAttachments(items);
  }
  async function selectFiles(next: File[]) {
    if (activeSend.current || fittingFiles.current || !canAddAttachments || !next.length) return;
    if (attachmentDrafts.current.length + next.length > 10) {
      setError(t('Можно прикрепить до 10 файлов.'));
      return;
    }
    if (next.some(file => !canPrepareAttachment(file, largeAttachmentLimit))) {
      setError(t('Файл пуст или превышает допустимый размер.'));
      return;
    }
    setError('');
    setAttachmentMenu(false);
    if (next.some(file => file.size > (imageMime(file.type) ? chatImageLimit : largeAttachmentLimit))) {
      const controller = new AbortController();
      fittingFiles.current = controller;
      setFitting(true);
      try {
        const fitted: File[] = [];
        for (const file of next) {
          fitted.push(await fitChatAttachment(file, largeAttachmentLimit, controller.signal));
          if (!mounted.current || !canAttachFiles.current) return;
        }
        next = fitted;
      } catch {
        if (mounted.current) setError(t('Файл пуст или превышает допустимый размер.'));
        return;
      } finally {
        fittingFiles.current = undefined;
        if (mounted.current) setFitting(false);
      }
    }
    const added = next.map(createMediaDraft);
    updateAttachments([...attachmentDrafts.current, ...added]);
    setFileOperation(newOperation());
    for (const item of added) {
      if (!videoMime(item.file.type) && !(mediaVariants && visualMime(item.file.type))) continue;
      const preparation = prepareDraft(item.file, mediaVariants).then(prepared => {
        const { poster, view, duration } = prepared;
        disposeDraft(prepared);
        if (poster && attachmentDrafts.current.some(draft => draft.id === item.id)) {
          const posterURL = URL.createObjectURL(poster);
          updateAttachments(attachmentDrafts.current.map(draft => draft.id === item.id ? { ...draft, posterURL } : draft));
        }
        return { poster, view, duration };
      }).catch(() => undefined);
      preparedMedia.current.set(item.id, preparation);
    }
  }
  function removeAttachment(id: string) {
    if (activeSend.current) return;
    const item = attachmentDrafts.current.find(draft => draft.id === id);
    if (!item) return;
    disposeDraft(item);
    preparedMedia.current.delete(id);
    updateAttachments(attachmentDrafts.current.filter(draft => draft.id !== id));
    setFileOperation(newOperation());
  }
  function renameAttachment(id: string, name: string) {
    if (activeSend.current) return;
    const item = attachmentDrafts.current.find(draft => draft.id === id);
    if (!item || item.file.name === name) return;
    const file = new File([item.file], name, { type: item.file.type, lastModified: item.file.lastModified });
    updateAttachments(attachmentDrafts.current.map(draft => draft.id === id ? { ...draft, file } : draft));
    setFileOperation(newOperation());
  }
  const deferredBasis = protection?.deferredBasis;
  const waitingForKey = protection && deferredBasis && !protection.allowSend && ['CUTOFF_EXPIRED', 'FRESH_KEY_PENDING',
    'CURRENT_KEY_PENDING', 'CURRENT_GRACE', 'PREVIOUS_GRACE'].includes(protection.reason);
  const canQueueText = waitingForKey && sendGranted && !readOnly && !attachments.length && !!draft?.text.trim();

  async function send(voice?: VoiceDraft, resume = false) {
    const selected = voice ? [{ file: voice.file }] : resume ? [] : attachmentDrafts.current;
    const { text, mentions } = trimMessage(voice ? '' : draft?.text ?? '', voice ? [] : draft?.mentions);
    const queued = resume ? deferred : undefined;
    const reply = queued ? queued.replyTo : replyTo;
    if (activeSend.current || fittingFiles.current || timedOut || (!text.trim() && !selected.length) || (!resume && !voice && deferred) ||
        (voice ? !canSendVoice : selected.length > 0 && !canAttach) || (!queued && reply !== undefined && !draftOriginal)) return;
    if (new TextEncoder().encode(text).length > (selected.length ? 4096 : 12288)) {
      setError(t('Сообщение слишком длинное.'));
      return;
    }
    if (!resume && !voice && canQueueText && draft && deferredBasis) {
      setError('');
      setDeferred(draft.operationId, { basis: deferredBasis, replyTo: reply });
      return;
    }
    if (!canSend || (resume && (!queued || !protection?.allowSend || !deferredBasis))) return;
    if (voice && voiceOperation.current?.file !== voice.file) voiceOperation.current = { file: voice.file, id: newOperation() };
    const operationId = voice ? voiceOperation.current!.id : selected.length ? fileOperation : draft!.operationId;
    activeSend.current = true;
    setSending(true);
    setError('');
    const field = composer.current;
    flightCleanup.current?.();
    flightOrigin.current = !resume && text ? composerTextOrigin(field) : undefined;
    following.current = true;
    initialUnread.current = undefined;
    preservedScroll.current = undefined;
    if (text) setOutgoing({ text, mentions, own: true, authorProfileId: ownProfileId, sentAt: Date.now(), replyTo: reply });
    let confirmed = false;
    try {
      const renditions = [];
      for (const item of selected) {
        const media = 'id' in item ? await preparedMedia.current.get(item.id) : undefined;
        if (!mounted.current || sendingPaused.current) return;
        renditions.push(media);
      }
      const views = allocateMediaViews(renditions);
      const fileIds: string[] = [];
      for (const [slot, { file }] of selected.entries()) {
        const media = renditions[slot];
        const mime = imageMime(file.type) || ['image/gif', 'video/mp4', 'video/webm', 'audio/webm', 'audio/ogg'].includes(file.type)
          ? file.type : 'application/octet-stream';
        const bytes = new Uint8Array(await file.arrayBuffer());
        const poster = media?.poster && { mime: media.poster.type, bytes: new Uint8Array(await media.poster.arrayBuffer()) };
        const playback = views[slot];
        const view = playback && { bytes: new Uint8Array(await playback.arrayBuffer()) };
        if (!mounted.current || sendingPaused.current) return;
        fileIds.push(await membership<string>('chat.protected.stageAttachment', { serverId, channelId, operationId, slot,
          file: { name: file.name, mime, bytes, duration: media?.duration,
            ...(videoMime(mime) ? { poster } : mediaVariants ? { preview: poster, view } : {}),
            ...(voice && { voice: { duration: voice.duration, waveform: voice.waveform } }) } }));
      }
      if (!mounted.current || sendingPaused.current) return;
      const receipt = await membership<{ Position?: number }>('chat.protected.send', { serverId, channelId, text, operationId, replyTo: reply,
        ...(queued && { deferred: queued.basis }), ...(fileIds.length && { fileIds }),
        ...(mentions.length > 0 && { mentions }) });
      if (!voice && draft) clearDraft(draft.operationId);
      if (!mounted.current) return;
      confirmed = typeof receipt?.Position === 'number';
      if (confirmed) setOutgoing(value => value && { ...value, position: receipt.Position });
      if (voice) {
        setRecording(false);
        voiceOperation.current = undefined;
      } else {
        attachmentDrafts.current.forEach(disposeDraft);
        preparedMedia.current.clear();
        updateAttachments([]);
        setFileOperation(newOperation());
      }
      setReplyTo(undefined);
      void load(false, false, hasMoreRef.current && following.current ? 'latest' : undefined);
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      if (code === 'PROTECTED_KEY_PENDING' && !voice && !selected.length && draft && deferredBasis) {
        if (!queued) setDeferred(draft.operationId, { basis: deferredBasis, replyTo: reply });
      } else {
        if (queued && draft && !['CONNECTION_FAILED', 'NOT_CONNECTED', 'RATE_LIMIT'].includes(code ?? '')) setDeferred(draft.operationId);
        if (mounted.current) setError((failure as Error).message);
      }
    } finally {
      activeSend.current = false;
      if (mounted.current) {
        if (!confirmed) {
          flightOrigin.current = undefined;
          flightCleanup.current?.();
          setOutgoing(undefined);
        }
        setSending(false);
        if (!resume) requestAnimationFrame(() => {
          const focused = document.activeElement;
          if (mounted.current && !sendingPaused.current && document.hasFocus() && !document.querySelector('dialog[open]') &&
              (focused === document.body || focused === field || focused?.matches('.protected-chat-submit'))) {
            composer.current?.focus({ preventScroll: true });
          }
        });
      }
    }
  }
  const resumeDeferred = useEffectEvent(() => { void send(undefined, true); });
  useEffect(() => {
    if (deferred && canSend && !timedOut && protection?.allowSend && protection.deferredBasis) resumeDeferred();
  }, [deferred, canSend, timedOut, protection]);
  async function remove(position: number, completedPoll?: boolean) {
    if (readOnly || mutating) return;
    setMutating(true);
    setDeleteError('');
    try {
      await membership('chat.protected.delete', { serverId, channelId, position, completedPoll });
      if (!mounted.current) return;
      locallyRemoved.current.add(position);
      versions.current.delete(position);
      pendingEdits.current.delete(position);
      setMessages(previous => pruneHistory(previous, first.current ?? 1, new Set([position])));
      setReplyTo(selected => selected === position ? undefined : selected);
      setDeleting(undefined);
      await load(true);
    } catch (failure) {
      if (mounted.current) setDeleteError((failure as Error).message);
    } finally {
      if (mounted.current) setMutating(false);
    }
  }
  async function edit() {
    if (mutating || !canSend || timedOut || !editing?.text.trim() || editing.text === editing.originalText) return;
    setMutating(true);
    setEditError('');
    try {
      const { originalText, ...draft } = editing;
      const result = await membership<{ revision: number }>('chat.protected.edit', { serverId, channelId, ...draft, text: trimMessage(draft.text).text });
      if (!mounted.current) return;
      pendingEdits.current.set(draft.position, result.revision);
      setEditing(undefined);
      await load(true);
    } catch (failure) {
      if (mounted.current) setEditError((failure as Error).message);
    } finally {
      if (mounted.current) setMutating(false);
    }
  }
  async function pin(position: number, pinned: boolean) {
    if (readOnly || mutating || !pins?.canPin) return;
    setMutating(true);
    setError('');
    try {
      await membership('chat.protected.pin', { serverId, channelId, position, pinned });
      if (!mounted.current) return;
      if (!pinned) {
        setPins(previous => previous && ({ ...previous, items: previous.items.filter(item => item.position !== position) }));
      }
      await load(true);
    } catch (failure) {
      if (mounted.current) setError((failure as Error).message);
    } finally {
      if (mounted.current) setMutating(false);
    }
  }
  const mayRemove = (message: ProtectedMessage) => !readOnly && !message.locked &&
    (message.completedPoll ? canDeletePoll : !message.dedicatedDeletion && (message.own || canDeleteOther));
  const deletionTarget = messages.find(message => message.position === deleting && mayRemove(message));
  const deletingPoll = deletionTarget && !deletionTarget.locked ? deletionTarget.completedPoll : undefined;
  const deletionTitle = (completedPoll?: boolean) => t(completedPoll ? 'Удалить завершённый опрос' : 'Удалить сообщение');
  const mayEdit = (message: ProtectedMessage) => !message.locked && message.canEdit && canSend && !timedOut;
  const mayReply = (message: ProtectedMessage) => !message.locked && canSend && !timedOut && !sending;
  const pinnedPositions = new Set(pins?.items.map(item => item.position));
  const pinLabel = (pinned: boolean) => t(pinned ? 'Открепить сообщение' : 'Закрепить сообщение');
  const originals = new Map(messages.filter(message => !message.locked).map(message => [message.position, message]));
  const menuMessage = messageMenu ? originals.get(messageMenu.position) : undefined;
  function beginEdit(message: ProtectedMessage & ReadableMessage) {
    if (message.checklist) {
      setEditingChecklist({ position: message.position, expectedRevision: message.revision ?? 1,
        text: message.text, checklist: message.checklist });
      return;
    }
    setEditError('');
    setEditing({ position: message.position, expectedRevision: message.revision ?? 1, text: message.text, originalText: message.text,
      operationId: crypto.randomUUID().replaceAll('-', '') });
  }
  function beginDelete(position: number) {
    setDeleteError('');
    setDeleting(position);
  }
  function messageActions(message: ProtectedMessage & ReadableMessage): MenuItem[] {
    const items: MenuItem[] = [];
    if (mayReply(message)) items.push({ icon: 'reply', label: t('Ответить'), action: () => selectReply(message.position) });
    if (message.text) items.push({ icon: 'copy', label: t('Скопировать текст'), action: () => {
      void membership('copy', { text: message.text }).catch(failure => setError((failure as Error).message));
    } });
    if (mayEdit(message)) items.push({ icon: 'edit', label: t('Редактировать сообщение'), action: () => beginEdit(message) });
    if (pins?.canPin) {
      const pinned = pinnedPositions.has(message.position);
      items.push({ icon: pinned ? 'pin-off' : 'pin', label: pinLabel(pinned), disabled: mutating,
        action: () => void pin(message.position, !pinned) });
    }
    if (mayRemove(message)) items.push({ icon: 'trash', label: deletionTitle(message.completedPoll),
      danger: true, separatorBefore: items.length > 0, disabled: mutating, action: () => beginDelete(message.position) });
    return items;
  }
  const menuItems = menuMessage && !readOnly ? messageActions(menuMessage) : [];
  const draftOriginal = replyTo === undefined ? undefined : originals.get(replyTo);
  useEffect(() => {
    if (replyTo !== undefined && draftOriginal === undefined) setReplyTo(undefined);
  }, [replyTo, draftOriginal]);
  const excerpt = (message: ReadableMessage) => message.text.slice(0, 240);
  function selectReply(position?: number) {
    if (position !== replyTo) {
      setReplyTo(position);
      if (draft?.text) changeDraft(draft.text, draft.mentions);
      if (attachments.length) setFileOperation(newOperation());
      voiceOperation.current = undefined;
    }
    composer.current?.focus();
  }
  function authorName(message: ReadableMessage) {
    if (message.pollResult) return t('Система');
    return authorProfile(message)?.name || t(message.own ? 'Вы' : 'Участник');
  }
  function authorProfile(message: ReadableMessage) {
    const id = message.authorProfileId ?? (message.own ? ownProfileId : undefined);
    return id ? authorNames?.get(id) ?? additionalAuthors?.get(id) : undefined;
  }
  const currentPin = pins?.items[0];
  const currentPinMessage = currentPin && originals.get(currentPin.position);
  const pinPosition = currentPin?.position;
  const pinRevision = currentPin?.revision;
  const needsPinPreview = !readOnly && pinPosition !== undefined && !currentPinMessage;
  useEffect(() => {
    if (!needsPinPreview || pinPosition === undefined || pinRevision === undefined) return;
    let active = true;
    void membership<ProtectedMessage | undefined>('chat.protected.pinnedMessage', { serverId, channelId, position: pinPosition })
      .then(message => {
        if (active && message && !message.locked && message.position === pinPosition && (message.revision ?? 1) === pinRevision) {
          setPinPreview({ position: pinPosition, revision: pinRevision, text: pinnedMessagePreview(message) });
        }
      }).catch(() => {});
    return () => { active = false; };
  }, [needsPinPreview, pinPosition, pinRevision, serverId, channelId]);
  const pinText = currentPinMessage ? pinnedMessagePreview(currentPinMessage) :
    pinPreview && pinPreview.position === pinPosition && pinPreview.revision === pinRevision ? pinPreview.text : t('Сообщение');
  const lastMessage = messages.at(-1);
  const outgoingContinues = outgoing && continuesMessage(outgoing, lastMessage?.locked ? undefined : lastMessage);
  const unreadBelow = messages.filter(message => message.position > seenPosition && !message.locked && !message.own).length;
  const moreUnread = hasMore && newestPosition > Math.max(seenPosition, messages.at(-1)?.position ?? 0);
  const hasUnreadBelow = unreadBelow > 0 || moreUnread;
  const jumpLabel = t(hasUnreadBelow ? 'К новым сообщениям' : 'К последним сообщениям');
  function jumpToMessage(position: number) {
    latestJump.current++;
    queuedJump.current = undefined;
    scrollTarget.current = undefined;
    const row = messageNodes.current.get(position);
    if (row && originals.has(position)) {
      revealMessage(row, true);
      return;
    }
    if (!readOnly) void load(false, false, position);
  }
  function jumpToLatest() {
    const list = history.current;
    if (!list) return;
    latestJump.current++;
    queuedJump.current = undefined;
    if (hasMoreRef.current && !offline) {
      void load(false, false, 'latest');
      return;
    }
    smoothScrollToLatest(list);
    (composer.current ?? list).focus({ preventScroll: true });
  }
  function smoothScrollToLatest(list: HTMLDivElement) {
    const bottom = list.scrollHeight - list.clientHeight;
    following.current = !hasMoreRef.current && list.scrollTop >= bottom - 1;
    list.scrollTo({ top: bottom, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    if (following.current) rememberRead();
  }
  function acknowledgeUnreadMarker() {
    if (!unreadMarker || unreadMarker.closing) return;
    rememberRead();
    if (hasMoreRef.current || lastSeen.current < Math.max(unreadMarker.position, messages.at(-1)?.position ?? 0)) return;
    const animate = messageNodes.current.has(unreadMarker.position) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    setUnreadMarker(animate ? { ...unreadMarker, closing: true } : undefined);
  }
  function renderReply(reference: number | null) {
    const original = reference === null ? undefined : originals.get(reference);
    if (reference === null || !original && (readOnly || reference < (first.current ?? 1) ||
        locallyRemoved.current.has(reference) || messageNodes.current.has(reference))) {
      return <div className="member-reply">{t('Исходное сообщение уже недоступно.')}</div>;
    }
    return <button type="button" className="member-reply chat-reply-quote"
      onClick={() => jumpToMessage(reference)}>
      <Icon name="reply" size={13}/>
      {original ? <><strong>{authorName(original)}</strong>
        <span><MessageText text={excerpt(original)} preview/></span></> : <strong>{t('К исходному сообщению')}</strong>}
    </button>;
  }
  return <ProtectedChatFrame channelName={channelName}>
      {offline && <p className="member-empty" role="status">{t('Нет соединения. Показана последняя загруженная история. Актуальность доступа не подтверждена.')}</p>}
      {!readOnly && currentPin && <button type="button" className="protected-pin-banner"
        onClick={() => jumpToMessage(currentPin.position)}>
        <Icon name="pin" size={16}/>
        <span>{pinText}</span>
      </button>}
      <div className="chat-feed">
      <div className="member-history chat-stream protected-chat-stream" ref={history} tabIndex={0} role="log" aria-label={t('Сообщения')}
        onWheel={event => {
          if (readOnly || !event.deltaY) return;
          const node = event.currentTarget;
          if (event.deltaY < 0 && node.scrollTop < 64) void load(false, true);
          if (event.deltaY > 0 && hasMoreRef.current && node.scrollHeight - node.clientHeight - node.scrollTop < 64) void load();
        }}
        onLoadCapture={followHistory} onScroll={event => {
          const node = event.currentTarget;
          node.classList.add('is-scrolling');
          clearTimeout(scrollTimer.current);
          scrollTimer.current = setTimeout(() => node.classList.remove('is-scrolling'), 800);
          const delta = node.scrollTop - scrollTop.current;
          const previous = resizePosition.current;
          if (!delta || previous && (previous.width !== node.clientWidth || previous.height !== node.clientHeight)) return;
          scrollTop.current = node.scrollTop;
          const bottom = node.scrollHeight - node.clientHeight - node.scrollTop;
          following.current = !hasMoreRef.current && bottom < 36;
          setAboveLatest(bottom >= 36);
          rememberResizePosition(node);
          rememberRead();
          if (!readOnly && delta < 0 && node.scrollTop < 64) void load(false, true);
          if (!readOnly && delta > 0 && hasMoreRef.current && bottom < 64) void load();
          const entry = cache.get(cacheKey);
          if (entry) {
            entry.scrollTop = scrollTop.current;
            entry.following = following.current;
          }
        }}>
        {!readOnly && !messages.length && !hasMore && !outgoing && !readError && <ChatEmptyState
          onCompose={canSend && !timedOut && !recording && !sending ? () => {
            setShowPreview(false);
            requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
          } : undefined}/>}
        {loadingHistory && <ProtectedHistoryLoading keysPending={preparingAccess}/>}
        {(!loadingHistory && (offline || historyConfirmed) ? messages : []).map((message, index) => {
          const previous = messages[index - 1];
          const firstUnread = unreadMarker?.position === message.position;
          const joinsPrevious = !message.locked && continuesMessage(message, previous?.locked ? undefined : previous);
          const name = message.locked ? t('Участник') : authorName(message);
          const gallery = message.locked ? undefined : message.files?.filter(hasGalleryPreview);
          const pinned = pinnedPositions.has(message.position);
          const continuation = joinsPrevious && !firstUnread;
          const groupBoundary = joinsPrevious && firstUnread;
          const avatar = !message.locked && <Avatar className="chat-avatar" name={name}
            image={(message.own ? ownAvatar : undefined) ??
              authorProfile(message)?.avatar}/>;
          const heading = !message.locked && <div className="member-message-heading chat-meta">
            <strong style={{ color: message.pollResult ? undefined : authorProfile(message)?.color }}>{name}</strong>
            <MessageTime sent={message.sentAt}/>
          </div>;
          return <Fragment key={message.position}>
          {firstUnread && <div className="chat-unread-divider" data-closing={unreadMarker.closing || undefined}
            onAnimationEnd={() => setUnreadMarker(marker => marker?.position === message.position && marker.closing ? undefined : marker)}>
            <div><span>{t('Новые сообщения')}</span></div>
          </div>}
          <article className={`member-message chat-message${continuation ? ' chat-message-continuation' : ''}`}
            data-regrouping={groupBoundary && unreadMarker?.closing || undefined} ref={node => {
            if (node) messageNodes.current.set(message.position, node);
            else messageNodes.current.delete(message.position);
          }}>
            <div className="chat-message-row" onContextMenu={event => {
              if (event.defaultPrevented || readOnly || message.locked || !messageActions(message).length) return;
              event.preventDefault();
              setMessageMenu({ position: message.position, x: event.clientX, y: event.clientY, anchor: event.currentTarget });
            }}>
              {message.locked ? <span className="chat-avatar" aria-hidden="true"/> :
                message.pollResult ? <span className="chat-system-avatar" aria-hidden="true"><Icon name="paw" size={22}/></span> :
                continuation ? <span className="chat-continuation-time"><MessageTime sent={message.sentAt} compact/></span> :
                groupBoundary ? <div className="chat-regroup-avatar">{avatar}</div> : avatar}
              <div className="member-message-content chat-message-body">
                {!message.locked && !continuation && (groupBoundary ? <div className="chat-regroup-heading">{heading}</div> : heading)}
                {!message.locked && message.replyTo !== undefined && renderReply(message.replyTo)}
                {!readOnly && !message.locked && message.checklist ?
                  <ProtectedChecklist serverId={serverId} channelId={channelId} position={message.position}
                    title={message.text} items={message.checklist.items} timedOut={timedOut}/> :
                  !readOnly && !message.locked && message.poll ?
                    <ProtectedPoll serverId={serverId} channelId={channelId} position={message.position}
                      title={message.text} poll={message.poll} timedOut={timedOut} onClosed={markPollClosed}
                      profiles={authorNames} ownProfileId={ownProfileId} ownAvatar={ownAvatar}/> :
                  !message.locked && message.pollResult ?
                    <div className="poll-result">
                      <strong>{t('Опрос «{0}» завершен', message.text)}</strong>
                      <span>{message.pollResult.winners.join(' · ') || t('Нет голосов')}</span>
                      {message.originalPollPosition !== undefined && originals.has(message.originalPollPosition) &&
                        <button type="button" onClick={() => jumpToMessage(message.originalPollPosition!)}>
                          {t('Просмотреть опрос')}
                        </button>}
                    </div> :
                  <div className="member-message-text" style={flightActive && outgoing?.position === message.position ? { visibility: 'hidden' } : undefined}>{message.locked ? t('Нет ключа для этого сообщения.') :
                    <MessageText text={message.text} verifiedMentions={message.mentions} roleColors={roleColors} allowRemotePreview={!offline}/>}
                    {!message.locked && message.editedAt !== undefined && <small className="chat-edited"
                      title={new Date(message.editedAt).toLocaleString()}>{t('Изменено')}</small>}
                  </div>}
                {!message.locked && (message.image || !!message.files?.length) && <div className="chat-message-attachments"
                  data-multiple={(message.files?.length ?? 0) + Number(!!message.image) > 1}>
                  {message.image && <ChatFile serverId={serverId} channelId={channelId} protectedPosition={message.position}
                    file={{ ...message.image, name: message.image.name ?? t('Изображение'), size: message.image.size ?? 0 }}/>}
                  {message.files?.map(file => <ChatFile key={file.id} serverId={serverId} channelId={channelId}
                    file={file} group={gallery} protectedPosition={message.position} author={name}
                    avatar={(message.own ? ownAvatar : undefined) ?? authorProfile(message)?.avatar} date={message.sentAt}/>)}
                </div>}
              </div>
              {pinned && !message.locked && <span className="chat-message-pin" role="img"
                aria-label={t('Закреплённое сообщение')} title={t('Закреплённое сообщение')}><Icon name="pin" size={14}/></span>}
              {!readOnly && (mayReply(message) || mayRemove(message) || mayEdit(message) || (!message.locked && pins?.canPin)) && <div className="member-message-actions">
                {mayReply(message) && <button type="button" className="icon-button" title={t('Ответить')}
                  aria-label={t('Ответить')} onClick={() => selectReply(message.position)}><Icon name="reply" size={16}/></button>}
                {!message.locked && pins?.canPin && (() => {
                  const label = pinLabel(pinned);
                  return <button type="button" className="icon-button" aria-pressed={pinned} aria-label={label} title={label}
                    disabled={mutating} onClick={() => void pin(message.position, !pinned)}><Icon name={pinned ? 'pin-off' : 'pin'} size={16}/></button>;
                })()}
                {!message.locked && mayEdit(message) && <button type="button" className="icon-button" title={t('Редактировать сообщение')}
                  aria-label={t('Редактировать сообщение')} onClick={() => beginEdit(message)}><Icon name="edit" size={16}/></button>}
                {!message.locked && mayRemove(message) && <button type="button" className="icon-button"
                  title={deletionTitle(message.completedPoll)} aria-label={deletionTitle(message.completedPoll)}
                  onClick={() => beginDelete(message.position)}><Icon name="trash" size={16}/></button>}
              </div>}
            </div>
          </article>
          </Fragment>;
        })}
        {outgoing && !readOnly && !confirmedOutgoing &&
          <article className={`member-message chat-message${outgoingContinues ? ' chat-message-continuation' : ''}${outgoing.position === undefined ? ' chat-message-pending' : ''}`} aria-busy={outgoing.position === undefined || undefined}>
          <div className="chat-message-row">
            {outgoingContinues ? <span className="chat-continuation-time"><MessageTime sent={outgoing.sentAt} compact/></span> :
              <Avatar className="chat-avatar" name={authorName(outgoing)} image={ownAvatar ?? authorProfile(outgoing)?.avatar}/>}
            <div className="member-message-content chat-message-body">
              {!outgoingContinues && <div className="member-message-heading chat-meta">
                <strong style={{ color: authorProfile(outgoing)?.color }}>{authorName(outgoing)}</strong><MessageTime sent={outgoing.sentAt}/>
              </div>}
              {outgoing.replyTo !== undefined && renderReply(outgoing.replyTo)}
              <div className="member-message-text" ref={flightTarget} style={flightActive ? { visibility: 'hidden' } : undefined}><MessageText text={outgoing.text} preview verifiedMentions={outgoing.mentions} roleColors={roleColors}/></div>
            </div>
          </div>
        </article>}
      </div>
        {!loadingHistory && (aboveLatest || hasMore && !offline) && <button type="button" className="member-load chat-jump protected-chat-jump"
          aria-label={unreadBelow && !moreUnread ? t('Новых сообщений: {0}', unreadBelow) : jumpLabel} title={jumpLabel} onClick={jumpToLatest}>
          <Icon name="arrow-down" size={20}/>
          {hasUnreadBelow && <b className="chat-jump-count" aria-hidden="true">{moreUnread ? unreadBelow ? `${unreadBelow}+` : '•' : unreadBelow}</b>}
        </button>}
      </div>
      {messageMenu && menuItems.length > 0 && <ContextMenu {...messageMenu} items={menuItems} onClose={() => setMessageMenu(undefined)}/>}
      {!offline && retryMessage && <p className="protected-chat-cooldown" role="status">{retryMessage}</p>}
      {!offline && (error || readError) && <p className="member-chat-error" role="alert">{error || readError}</p>}
      {(offline || historyConfirmed) && replyTo !== undefined && <div className="member-compose-context protected-reply-draft">
        <div className="member-reply"><Icon name="reply" size={16}/>
          <span>{draftOriginal ? <MessageText text={excerpt(draftOriginal)} preview/> : t('Исходное сообщение уже недоступно.')}</span>
        </div>
        <button type="button" className="icon-button" aria-label={t('Отменить ответ')}
          disabled={sending} onClick={() => selectReply()}>×</button>
      </div>}
      <ChatFileDrop channelName={channelName} enabled={canAddAttachments} onFiles={selectFiles}/>
      {composerEvents && !readOnly && <div className="chat-composer-activity-slot" role="status">
        <ChatComposerActivity serverId={serverId} channelId={channelId} ownProfileId={ownProfileId} names={authorNames}/>
      </div>}
      {!readOnly && recording && canSendVoice && !timedOut ?
        <VoiceComposer busy={sending} sendDisabled={pauseSending} onSend={voice => void send(voice)} onCancel={() => setRecording(false)}
          onRecordingChange={setRecordingActive}/> :
      <form className="member-composer chat-composer" onSubmit={event => { event.preventDefault(); composerActivity.stop(); void send(); }}
        onBlur={event => { if (event.target instanceof HTMLTextAreaElement) composerActivity.stop(); }}
        onClick={event => { if (event.target === composer.current) acknowledgeUnreadMarker(); }}
        onDragOver={event => {
          if (event.dataTransfer.types.includes(memberDragType) && canSend && !timedOut && !sending && composer.current) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={event => {
          const member = event.dataTransfer.getData(memberDragType);
          if (member) {
            event.preventDefault();
            const field = composer.current;
            if (!field || !canSend || timedOut || sending) return;
            const next = dropProtectedMemberMention(member, serverId, authorNames, draft?.text ?? '', draft?.mentions ?? [],
              field.selectionStart, field.selectionEnd);
            if (!next) return;
            changeDraft(next.text, next.mentions);
            if (attachments.length) setFileOperation(newOperation());
            requestAnimationFrame(() => { field.focus(); field.setSelectionRange(next.caret, next.caret); });
            return;
          }
        }}
        onPaste={event => {
          if (!canAddAttachments || !event.clipboardData.files.length) return;
          event.preventDefault();
          selectFiles(Array.from(event.clipboardData.files));
        }}
        onKeyDown={event => {
          if (!(event.target instanceof HTMLTextAreaElement) || event.defaultPrevented || event.key !== 'Enter' ||
              event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (!event.repeat) event.currentTarget.querySelector<HTMLButtonElement>('button[type=submit]')?.click();
        }}>
        {fitting && <span role="status" className="attachment-preparing">{t('Подготовка вложений…')}</span>}
        {attachments.length > 0 && <div className="protected-file-drafts" aria-label={t('Вложения')}>
          <AttachmentDrafts items={attachments} busy={sending} onRemove={removeAttachment} onRename={renameAttachment}/>
        </div>}
        <ProtectedComposerLayout>
        {!readOnly && !timedOut && (canAttach || canSendVoice || canCreatePoll || canCreateList) &&
          <div className="chat-attachment-control" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setAttachmentMenu(false);
          }} onKeyDown={event => {
            if (event.key === 'Escape' && attachmentMenu) {
              event.stopPropagation();
              setAttachmentMenu(false);
              attachmentButton.current?.focus();
            }
          }}>
            <input type="file" multiple hidden disabled={!canAddAttachments} ref={picker} onChange={event => {
              selectFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}/>
            <button ref={attachmentButton} type="button" className="chat-attach" aria-label={t('Вложения')} title={t('Вложения')}
              aria-haspopup="menu" aria-expanded={attachmentMenu} disabled={sending || pauseSending}
              onClick={() => setAttachmentMenu(!attachmentMenu)}><Icon name="plus" size={22}/></button>
            {attachmentMenu && <div className="chat-attachment-menu" role="menu" aria-label={t('Вложения')}>
              {canAttach && <button type="button" role="menuitem" disabled={!canAddAttachments}
                onClick={() => { setAttachmentMenu(false); picker.current?.click(); }}>
                <Icon name="image" size={18}/>{t('Отправить файл')}
              </button>}
              {canSendVoice && <button type="button" role="menuitem" disabled={!!deferred}
                onClick={() => { setAttachmentMenu(false); setRecording(true); }}>
                <Icon name="mic" size={18}/>{t('Записать голосовое')}
              </button>}
              {canCreateList && <button type="button" role="menuitem"
                onClick={() => { setAttachmentMenu(false); setCreatingList(true); }}>
                <Icon name="checklist" size={18}/>{t('Интерактивный список')}
              </button>}
              {canCreatePoll && <button type="button" role="menuitem"
                onClick={() => { setAttachmentMenu(false); setCreatingPoll(true); }}>
                <Icon name="chat" size={18}/>{t('Создать опрос')}
              </button>}
            </div>}
          </div>}
        <div className="chat-input-shell protected-chat-input-shell" data-preview={showPreview}>
          <button type="button" className="chat-preview-toggle icon-button" aria-pressed={showPreview}
            title={t(showPreview ? 'Отключить предпросмотр' : 'Предпросмотр')}
            aria-label={t(showPreview ? 'Отключить предпросмотр' : 'Предпросмотр')}
            onClick={() => {
              setShowPreview(!showPreview);
              if (showPreview) requestAnimationFrame(() => composer.current?.focus());
            }}><Icon name="eye" size={18}/></button>
          {showPreview && <div className="chat-compose-preview member-message-text" tabIndex={0} role="region" aria-label={t('Предпросмотр')}>
            <MessageText text={draft?.text ?? ''} verifiedMentions={draft?.mentions} roleColors={roleColors} allowRemotePreview={!offline}/>
          </div>}
          <ProtectedMentionTextarea input={composer} serverId={serverId} channelId={channelId} value={draft?.text ?? ''}
            placeholder={t('Написать в «{0}»', channelName)}
            mentions={draft?.mentions ?? []} disabled={sending || showPreview} canMention={canSend && !timedOut} onValue={(text, mentions) => {
              if (canPublishActivity && canSend && text.trim()) composerActivity.type();
              else composerActivity.stop();
              changeDraft(text, mentions);
              if (attachments.length) setFileOperation(newOperation());
            }}/>
        </div>
        <button className="icon-button protected-chat-submit" type="submit" aria-label={t(canQueueText ? 'Отправить после обновления ключа' : 'Отправить')}
          disabled={sending || fitting || !!deferred || (!canSend && !canQueueText) || timedOut || (!draft?.text.trim() && !attachments.length) ||
            (attachments.length > 0 && !canAttach) || (replyTo !== undefined && !draftOriginal)}>
          <Icon name="send" size={18}/>
        </button>
        </ProtectedComposerLayout>
      </form>}
      {deferred && <div className="member-compose-context member-reply">
        <span role="status">{t('Сообщение будет отправлено после обновления ключа.')}</span>
        <Button variant="quiet" type="button" disabled={sending} onClick={() => setDeferred(draft!.operationId)}>
          {t('Отменить отложенную отправку')}
        </Button>
      </div>}
      {creatingPoll && <PollDialog serverId={serverId} channelId={channelId} canSubmit={canCreatePoll && !timedOut && !pauseSending}
        commit={async (text, poll, operationId) => {
          await membership('chat.protected.send', { serverId, channelId, text, poll, operationId });
        }} onClose={() => setCreatingPoll(false)} onPosted={() => load()}/>}
      {creatingList && <ChecklistDialog serverId={serverId} channelId={channelId}
        canSubmit={canCreateList && !timedOut && !pauseSending}
        commit={async (content, operationId) => {
          await membership('chat.protected.send', { serverId, channelId, ...content, operationId });
        }}
        onClose={() => setCreatingList(false)} onPosted={() => void load()}/>}
      {editingChecklist && <ChecklistDialog serverId={serverId} channelId={channelId}
        initialContent={editingChecklist} canSubmit={canSend && !timedOut}
        commit={async (content, operationId) => {
          const { position, expectedRevision } = editingChecklist;
          const result = await membership<{ revision: number }>('chat.protected.edit', {
            serverId, channelId, position, expectedRevision, ...content, operationId,
          });
          if (mounted.current) pendingEdits.current.set(position, result.revision);
        }}
        onClose={() => setEditingChecklist(undefined)} onPosted={() => void load(true)}/>}
      {!readOnly && editing && <Modal className="chat-edit-modal" title={t('Редактировать сообщение')} onClose={() => { if (!mutating) setEditing(undefined); }} error={editError}>
        <form className="form-fields" onSubmit={event => { event.preventDefault(); void edit(); }}>
          <label>{t('Сообщение')}<FormattingTextarea autoFocus rows={1} maxLength={4096} value={editing.text} disabled={mutating}
            onChange={event => setEditing({ ...editing, text: event.target.value, operationId: crypto.randomUUID().replaceAll('-', '') })}/></label>
          <div className="modal-actions">
            <button type="button" disabled={mutating} onClick={() => setEditing(undefined)}>{t('Отмена')}</button>
            <button type="submit" className="primary" disabled={mutating || !canSend || timedOut || !editing.text.trim() || editing.text === editing.originalText}>
              {t('Сохранить')}
            </button>
          </div>
        </form>
      </Modal>}
      {deletionTarget &&
        <Modal title={deletionTitle(deletingPoll)} onClose={() => { if (!mutating) setDeleting(undefined); }} error={deleteError}>
          <p>{t(deletingPoll ? 'Опрос и его результат будут удалены для всех участников.' : 'Сообщение будет удалено для всех участников.')}</p>
          <div className="modal-actions">
            <button type="button" disabled={mutating} onClick={() => setDeleting(undefined)}>{t('Отмена')}</button>
            <button type="button" className="danger-button" disabled={mutating}
              onClick={() => void remove(deletionTarget.position, deletingPoll)}>{t('Удалить')}</button>
          </div>
        </Modal>}
  </ProtectedChatFrame>;
}
