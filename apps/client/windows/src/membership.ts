import type {PollDefinition} from '../../../../shared/polls.mjs';
import type {Mention} from '../../../../shared/mentions.mjs';
import { t } from './i18n';
export interface ServerRecord { serverId: string; address: string; name: string; status: 'online'|'offline'|'locked'; source?:'selfhost'|'external';ownedSelfhost?:boolean;leaveError?:string }
export interface Profile { id: string; nickname: string; revision: number; avatar?: string }
export interface Channel { id: string; name: string; kind: 'text'|'voice'; protected: boolean; position: number; revision: number; messageRevision: number; lastMessageId: number }
export interface TimeoutStatus { deadline: number; reason?: string; canSet: boolean; canLift: boolean }
export type ComposerActivity = 'typing' | 'recording' | 'idle';
export type ProtectedServerEvent = { serverId: string } & (
  { type: 'state' | 'resync' } | { type: 'chat'; channelId: string; pushed?: boolean } |
  { type: 'composer'; channelId: string; profileId: string; activity: ComposerActivity } |
  { type: 'voice'; channelId: string } | { type: 'status'; live: boolean });
export interface ProtectedServerState {
  apiProtocolVersion: 3;
  serverId: string;
  profileId: string;
  eventsLive?: boolean;
  composerEvents?: boolean;
  mediaVariants?: boolean;
  canManageChannels?: boolean;
  canEditOwnNickname?: boolean;
  canLiftOwnVoiceRestriction?: boolean;
  canLiftOwnServerVoiceRestriction?: boolean;
  canEditCommunity?: boolean;
  community?: { name: string; revision: number };
  communityAvatar?: { revision: number; avatar?: string; pending?: boolean };
  canEditRoles?: boolean;
  canAssignRoles?: boolean;
  canManageScopeAuthority?: boolean;
  canRevokeOwnDevices?: boolean;
  profileAvatarSupported?: boolean;
  profileAvatar?: { revision: number; avatar?: string; pending: boolean };
  canListMembers?: boolean;
  canManageTimeouts?: boolean;
  canManageBans?: boolean;
  canViewAudit?: boolean;
  canListInvites?: boolean;
  joinPending?: boolean;
  timeout?: TimeoutStatus;
  rotationQueue?: { waiting: number; processing: number };
  categories?: { id: string; name?: string }[];
  channels: { id: string; kind: 'text' | 'voice'; categoryId: string; name?: string; canOrder?: boolean; canEditSettings?: boolean; canInspectACL?: boolean; keysPending?: boolean;
    voiceParticipants?: { profileId: string; sessionId?: string; name?: string; muted?: boolean; deafened?: boolean;
      serverMuted?: boolean; serverDeafened?: boolean; selfMuted?: boolean; selfDeafened?: boolean }[];
    settings?: { name: string; description: string; slowmodeSeconds: number; voiceCapacity: number } }[];
}
export function isProtectedServerState(value: ServerState | ProtectedServerState): value is ProtectedServerState {
  return 'apiProtocolVersion' in value && value.apiProtocolVersion === 3;
}
export interface ServerState {
  eventsLive?:boolean;
  avatar?:string;avatarRevision?:number;capabilities?:string[]; serverId: string; name: string; revision: number; controlRevision: number;
  self: { effectiveProfileId: string; profileId: string; deviceId: string; role: 'member'|'moderator'|'admin'; permissions: string[] };
  profiles: Profile[]; channels: Channel[]; bindings: { source: string; target: string }[];
  members: { profileId: string; online: boolean; away?:boolean; role: string }[];
  devices: { id: string; label: string; originalProfileId: string; primary: boolean }[];
  voice: { profileId: string; deviceId: string; channelId: string; identity: string }[];
}
export interface MediaVariant { id: string; mime: 'image/webp'; size: number }
export interface ChatAttachment {id:string;mime:string;name:string;size:number;poster?:{id:string;mime:string};preview?:MediaVariant;view?:MediaVariant;duration?:number;voice?:{duration:number;waveform:number[]}}
export type ChatImageAttachment = Pick<ChatAttachment, 'id' | 'mime'> & Partial<Pick<ChatAttachment, 'name' | 'size' | 'preview' | 'view'>>;
export interface Message { systemKind?:'poll-result';locked?:boolean; id: number; channelId: string; authorProfileId: string; requestId: string; sentAt: number; editedAt?: number; unreadable?: boolean; content: { text: string; gif?:{source:string;url:string;mime?:'image/gif'|'video/mp4'|'video/webm'}; mentions?:Mention[];poll?:PollDefinition&{id:string};pollResult?:boolean; checklist?:{everyone:boolean;items:{id:string;text:string}[]}; files?:ChatAttachment[];file?:ChatAttachment; image?: ChatImageAttachment; reply?:{id:number;author:string;text:string} } }
export interface ServerEvent {serverId:string;type:'chat'|'state'|'resync';checklists?:{messageId:number;revision:number;checked:Record<string,boolean>}[];channelId?:string;revision?:number;last?:number;rescan?:boolean;delivery?:boolean;previous?:number;first?:number;messages?:Message[];deleted?:{id:number;authorProfileId:string;systemKind?:string}[]}
export interface MessagePage { revision?:number; messages: Message[]; first: number; last: number; hasOlder: boolean; hasNewer: boolean; unread: number }
const errors: Record<string, () => string> = {
  UNVERIFIED_EPOCH_POLICY: () => t('Пока не удалось подтвердить ключ канала. Клиент повторит проверку.'),
  PROTECTED_PROFILE_UNLINKED: () => t('Профиль отсоединён'),
  PROTECTED_DEVICE_REVOKED: () => t('Это устройство отвязано от сервера'),
  PROTECTED_REVOKE_SCOPE_SIGNER: () => t('Сначала передайте подпись подтверждений другому устройству в разделе «Доступ к серверу».'),
  PROFILE_AVATAR_CHANGED: () => t('Аватар профиля изменился. Откройте настройки заново.'),
  PROTECTED_ACCESS_DENIED: () => t('Недостаточно прав для этого действия.'),
  VOICE_CHANNEL_CONTROL_UNAVAILABLE: () => t('Клиент участника пока не принимает команды звонка.'),
  PROTECTED_DEFERRED_ADMISSION_CHANGED: () => t('Доступ к каналу изменился. Черновик сохранён.'),
  PROTECTED_TIMED_OUT: () => t('Общение временно ограничено тайм-аутом.'),
  PROTECTED_REVISION_CHANGED: () => t('Версия сообщения изменилась. Откройте актуальную версию.'),
  PROTECTED_TIMEOUT_CONFLICT: () => t('Этот запрос уже применён с другими параметрами.'),
  PROTECTED_AUDIT_CURSOR_EXPIRED: () => t('Журнал изменился. Загружаются актуальные записи.'),
  PROTECTED_AUDIT_RETENTION_CHANGED: () => t('Срок хранения изменился. Проверьте новое значение.'),
  PROTECTED_AUDIT_CONFIRM_RETENTION: () => t('Подтвердите удаление записей старше нового срока.'),
  PROTECTED_MESSAGE_DELETION_RESTRICTED: () => t('Для удаления этого сообщения требуется отдельное действие.'),
  PROTECTED_POLICY_CHANGED: () => t('Политика доступа изменилась. Откройте настройки заново.'),
  INVALID_CHANNEL_ORDER_PROOF: () => t('Доказательство изменения порядка недействительно.'),
  PROTECTED_PREVIEW_EXPIRED: () => t('Срок предпросмотра истёк. Проверьте изменение ещё раз.'),
  PROTECTED_RECOVERY_REQUIRED: () => t('Для выдачи прав администратора участнику нужно настроить восстановление доступа.'),
  PROTECTED_RECOVERY_PENDING: () => t('Сервер ещё готовит ключи. Повторите подтверждение с тем же набором сейчас или позже.'),
  RECOVERY_DEVICE_CHANGED: () => t('Данные восстановления изменились. Повторите действие с действующим резервным набором.'),
  INVALID_RECOVERY_BUNDLE: () => t('Проверьте, что резервный набор вставлен целиком.'),
  RECOVERY_KIT_PROFILE_MISMATCH: () => t('Этот резервный набор относится к другому профилю или серверу.'),
  PROTECTED_RECOVERY_KIT_RETIRED: () => t('Этот резервный набор отозван. Создайте и подтвердите новый набор.'),
  INVALID_PROTECTED_RECOVERY: () => t('Сервер не принял резервный набор. Проверьте, что он действующий и относится к нужному серверу.'),
  INVALID_RECOVERY_DEVICE_PROOF: () => t('Сервер не принял резервный набор. Проверьте, что он действующий и относится к нужному серверу.'),
  INVALID_DEVICE_BINDING_CARD: () => t('Проверьте, что карточка устройства вставлена целиком и относится к нужному серверу.'),
  INVALID_PROTECTED_DEVICE_BINDING: () => t('Не удалось проверить карточку устройства.'),
  INVALID_DEVICE_BINDING_PROOF: () => t('Сервер не подтвердил привязку. Проверьте карточку и срок её действия.'),
  DEVICE_BINDING_CONFLICT: () => t('Данные сервера изменились. Создайте новую карточку привязки.'),
  DEVICE_BINDING_RESULT_UNAVAILABLE: () => t('Подтверждение для этой карточки и устройства недоступно.'),
  INVALID_PROFILE_LINK_CARD: () => t('Проверьте, что карточка вставлена целиком и относится к нужному серверу.'),
  INVALID_PROFILE_LINK_PROOF: () => t('Сервер не подтвердил связывание. Проверьте карточку и срок её действия.'),
  INVALID_PROTECTED_PROFILE_LINKING: () => t('Не удалось проверить карточку связывания.'),
  INVALID_SCOPE_DEVICE_CARD: () => t('Карточка передачи подписи не подходит этому устройству.'),
  INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT: () => t('Не удалось проверить подпись изменения настроек канала.'),
  INVALID_PROTECTED_ROLE_SIGNATURE: () => t('Не удалось проверить подпись изменения ролей.'),
  PROTECTED_SCOPE_SIGNER_HANDOVER_REQUIRED: () => t('Сначала передайте подпись поканальных подтверждений другому устройству владельца.'),
  INVALID_POLL:()=>t('Проверьте вопрос и варианты опроса.'), POLL_CLOSED:()=>t('Опрос уже завершен.'), POLL_NOT_FOUND:()=>t('Опрос недоступен.'), POLL_LIMIT:()=>t('Слишком много активных опросов в этом чате.'), POLL_IMMUTABLE:()=>t('Опубликованный опрос нельзя редактировать.'),
  UNSUPPORTED_FEATURE:()=>t('Для этой функции обновите сервер.'),
  SERVER_NAME_CHANGED:()=>t('Название сервера уже изменилось. Обновите данные и повторите попытку.'), INVALID_SERVER_NAME:()=>t('Введите название сервера длиной от 1 до 64 символов.'),
  SERVER_AVATAR_CHANGED: () => t('Аватар сервера изменился. Откройте окно редактирования заново.'),
  MESSAGE_TOO_LARGE:()=>t('Сообщение слишком длинное.'), PRIMARY_DEVICE_REQUIRED:()=>t('Это действие доступно на основном устройстве.'),
  ADMIN_ROLE_MUST_BE_REMOVED:()=>t('Сначала снимите роль администратора.'), GROUP_CHANGED:()=>t('Состав устройств изменился. Повторите действие.'),
  INVITE_LIMIT:()=>t('Достигнут лимит приглашений этого типа. Отзовите ненужные ссылки.'),
  NOT_A_MEMBER: () => t('Вы больше не участник этого сервера.'), BANNED: () => t('Доступ к серверу заблокирован.'),
  INVITE_EXPIRED: () => t('Срок приглашения истёк. Попросите новую ссылку.'), INVITE_UNAVAILABLE: () => t('Приглашение недоступно. Попросите новую ссылку.'),
  INVALID_INVITE: () => t('Неверная ссылка приглашения.'),
  PROTECTED_INVITE_UNAVAILABLE: () => t('Приглашение недоступно. Попросите новую ссылку.'),
  PROTECTED_CUTOVER_CHANGED: () => t('Не удалось подтвердить подлинность сервера.'),
  PROTECTED_DEPARTURE_CHANGED: () => t('Данные изменились. Обновите их и повторите действие.'),
  PROTECTED_OWNER_LEAVE: () => t('Передайте владение сервером, прежде чем выйти.'),
  PROTECTED_OWNER_TRANSFER_UNAVAILABLE: () => t('Предложение больше недоступно. Обновите данные о владении.'),
  LAST_ADMIN: () => t('Сначала назначьте другого администратора.'), VOICE_OCCUPIED: () => t('Другое связанное устройство уже находится в голосовом канале.'),
  VOICE_FULL: () => t('В голосовом канале нет свободных мест.'),
  FORBIDDEN: () => t('Недостаточно прав для этого действия.'), REVISION_CONFLICT: () => t('Данные изменились. Обновите их и повторите действие.'),
  PROTECTED_CHANNEL: () => t('Этот канал защищён от удаления.'), LOCAL_KEY_MISSING: () => t('На этом устройстве нет ключа сервера. Свяжите устройства.'),
  NOT_CONNECTED: () => t('Нет соединения с сервером.'), CONNECTION_FAILED: () => t('Не удалось связаться с сервером.'),
  INVALID_SERVER_IDENTITY: () => t('Не удалось подтвердить подлинность сервера.'), SERVER_KEY_CHANGED: () => t('Ключ сервера изменился. Подключение остановлено.'),
  SERVER_ID_CHANGED:()=>t('Не удалось подтвердить подлинность сервера.'), SERVER_BINDING_MISMATCH:()=>t('Не удалось подтвердить подлинность сервера.'),
  UNSUPPORTED_PROTOCOL:()=>t('Версия API сервера не поддерживается. Обновите клиент или обратитесь к владельцу сервера.'),
  MIGRATION_MAINTENANCE:()=>t('Сервер ждёт подтверждения владельца для перехода на API 3.'),
  MIGRATION_DEVICE_DENIED:()=>t('Подтвердить перенос можно с устройства владельца сервера.'),
  PROTECTED_REJOIN_REQUIRED:()=>t('Сервер уже на API 3. Подключитесь по новому приглашению владельца.'),
  LEAVE_PENDING:()=>t('Выход с этого сервера ещё не подтверждён. Клиент отправит его при восстановлении связи.'),
  ECONNREFUSED:()=>t('Сервер недоступен. Проверьте, запущен ли он, и повторите подключение.'),
  ECONNRESET:()=>t('Соединение с сервером прервано. Клиент попробует подключиться снова.'),
  ETIMEDOUT:()=>t('Сервер не ответил вовремя. Клиент попробует подключиться снова.'),
  PROTECTED_MESSAGE_RATE_LIMIT:()=>t('Достигнут лимит отправки сообщений. Подождите и повторите отправку.'),
  PROTECTED_SLOWMODE:()=>t('В этом канале включён медленный режим. Подождите перед отправкой следующего сообщения.'),
};
export const protectedChannelOpenDelay = 180;

export async function membership<T = unknown>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  if (!window.desktop?.membership) throw Error(t('Подключение доступно в десктопном приложении.'));
  const result = await window.desktop.membership(action, input);
  if (result.error) {
    const { code, recoveryProfiles, retryAfter } = result.error;
    const message = code === 'RATE_LIMIT'
      ? (retryAfter ? t('Сервер ограничил частоту запросов. Повтор через {0} с.', retryAfter)
        : t('Сервер ограничил частоту запросов. Клиент повторит запрос после паузы.'))
      : errors[code]?.() || t('Не удалось выполнить действие ({0}).', code);
    throw Object.assign(Error(message), {
      code, retryAfter, ...(Array.isArray(recoveryProfiles) && { recoveryProfiles }),
    });
  }
  return result.value as T;
}
export function canRetryRoleChange(failure: unknown) {
  const code = (failure as { code?: string })?.code;
  return code !== undefined && ['CONNECTION_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'SERVER_ERROR'].includes(code);
}
export function isMembershipConnectionUnavailable(failure: unknown) {
  const code = (failure as { code?: string })?.code;
  return code !== undefined && ['CONNECTION_FAILED', 'NOT_CONNECTED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
    'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_REFUSED', 'ABORT_ERR'].includes(code);
}
export function roleChangeMessage(failure: unknown, profiles: { id: string; name?: string }[] = []) {
  const error = failure as Error & { recoveryProfiles?: string[] };
  if (!error.recoveryProfiles?.length) return error.message;
  const names = new Map(profiles.map(profile => [profile.id, profile.name]));
  return t('Этим участникам нужно настроить восстановление доступа — {0}.',
    error.recoveryProfiles.map(profile => names.get(profile) ?? t('Участник · {0}', profile.slice(0, 8))).join(', '));
}
export function effectiveProfile(state: ServerState, original: string) { return state.bindings.find(binding => binding.source === original)?.target || original; }
export function profileFor(state: ServerState, original: string) { return state.profiles.find(profile => profile.id === effectiveProfile(state, original)); }
export function storedJSON<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
export const cursorKey = (server: string, channel: string) => `pawtalk.v2.read.${server}.${channel}`;
export const isServerMuted = (server: string) => Number(localStorage.getItem(`pawtalk.v2.mute.${server}`)) > Date.now();

export const channelMuteKey=(server:string,channel:string)=>`pawtalk.v2.mute-channel.${server}.${channel}`;
export const isChannelMuted=(server:string,channel:string)=>Number(localStorage.getItem(channelMuteKey(server,channel)))>Date.now();
export const notificationsMuted=(server:string,channel:string)=>isServerMuted(server)||isChannelMuted(server,channel);
