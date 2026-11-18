import type {PollDefinition} from '../shared/polls.mjs';
import type {Mention} from '../shared/mentions.mjs';
import { t } from './i18n';
export interface ServerRecord { serverId: string; address: string; name: string; status: 'online'|'offline'|'locked'; source?:'selfhost'|'external';ownedSelfhost?:boolean;leaveError?:string }
export interface Profile { id: string; nickname: string; revision: number; avatar?: string }
export interface Channel { id: string; name: string; kind: 'text'|'voice'; protected: boolean; position: number; revision: number; messageRevision: number; lastMessageId: number }
export interface ServerState {
  eventsLive?:boolean;
  avatar?:string;avatarRevision?:number;capabilities?:string[]; serverId: string; name: string; revision: number; controlRevision: number;
  self: { effectiveProfileId: string; profileId: string; deviceId: string; role: 'member'|'moderator'|'admin'; permissions: string[] };
  profiles: Profile[]; channels: Channel[]; bindings: { source: string; target: string }[];
  members: { profileId: string; online: boolean; away?:boolean; role: string }[];
  devices: { id: string; label: string; originalProfileId: string; primary: boolean }[];
  voice: { profileId: string; deviceId: string; channelId: string; identity: string }[];
}
export interface Message { systemKind?:'poll-result';locked?:boolean; id: number; channelId: string; authorProfileId: string; requestId: string; sentAt: number; editedAt?: number; unreadable?: boolean; content: { text: string; mentions?:Mention[];poll?:PollDefinition&{id:string};pollResult?:boolean; image?: { id: string; mime: string }; reply?:{id:number;author:string;text:string} } }
export interface ServerEvent {serverId:string;type:'chat'|'state'|'resync';channelId?:string;revision?:number;last?:number;rescan?:boolean;delivery?:boolean;previous?:number;first?:number;messages?:Message[];deleted?:{id:number;authorProfileId:string;systemKind?:string}[]}
export interface MessagePage { revision?:number; messages: Message[]; first: number; last: number; hasOlder: boolean; hasNewer: boolean; unread: number }
const errors: Record<string, () => string> = {
  INVALID_POLL:()=>t('Проверьте вопрос и варианты опроса.'), POLL_CLOSED:()=>t('Опрос уже завершен.'), POLL_NOT_FOUND:()=>t('Опрос недоступен.'), POLL_LIMIT:()=>t('Слишком много активных опросов в этом чате.'), POLL_IMMUTABLE:()=>t('Опубликованный опрос нельзя редактировать.'),
  UNSUPPORTED_FEATURE:()=>t('Для этой функции обновите сервер.'),
  SERVER_NAME_CHANGED:()=>t('Название сервера изменилось. Откройте окно переименования заново.'), INVALID_SERVER_NAME:()=>t('Введите название сервера длиной от 1 до 64 символов.'),
  MESSAGE_TOO_LARGE:()=>t('Сообщение слишком длинное.'), PRIMARY_DEVICE_REQUIRED:()=>t('Это действие доступно на основном устройстве.'),
  ADMIN_ROLE_MUST_BE_REMOVED:()=>t('Сначала снимите роль администратора.'), GROUP_CHANGED:()=>t('Состав устройств изменился. Повторите действие.'),
  INVITE_LIMIT:()=>t('Достигнут лимит приглашений этого типа. Отзовите ненужные ссылки.'),
  NOT_A_MEMBER: () => t('Вы больше не участник этого сервера.'), BANNED: () => t('Доступ к серверу заблокирован.'),
  INVITE_EXPIRED: () => t('Срок приглашения истёк. Попросите новую ссылку.'), INVITE_UNAVAILABLE: () => t('Приглашение недоступно. Попросите новую ссылку.'),
  LAST_ADMIN: () => t('Сначала назначьте другого администратора.'), VOICE_OCCUPIED: () => t('Другое связанное устройство уже находится в голосовом канале.'),
  FORBIDDEN: () => t('Недостаточно прав для этого действия.'), REVISION_CONFLICT: () => t('Данные изменились. Обновите их и повторите действие.'),
  PROTECTED_CHANNEL: () => t('Этот канал защищён от удаления.'), LOCAL_KEY_MISSING: () => t('На этом устройстве нет ключа сервера. Свяжите устройства.'),
  NOT_CONNECTED: () => t('Нет соединения с сервером.'), CONNECTION_FAILED: () => t('Не удалось связаться с сервером.'),
  INVALID_SERVER_IDENTITY: () => t('Не удалось подтвердить подлинность сервера.'), SERVER_KEY_CHANGED: () => t('Ключ сервера изменился. Подключение остановлено.'),
  SERVER_ID_CHANGED:()=>t('Не удалось подтвердить подлинность сервера.'), SERVER_BINDING_MISMATCH:()=>t('Не удалось подтвердить подлинность сервера.'),
  UNSUPPORTED_PROTOCOL:()=>t('Версия API сервера не поддерживается. Обновите клиент или обратитесь к владельцу сервера.'),
  LEAVE_PENDING:()=>t('Выход с этого сервера ещё не подтверждён. Клиент отправит его при восстановлении связи.'),
  ECONNREFUSED:()=>t('Сервер недоступен. Проверьте, запущен ли он, и повторите подключение.'),
  ECONNRESET:()=>t('Соединение с сервером прервано. Клиент попробует подключиться снова.'),
  ETIMEDOUT:()=>t('Сервер не ответил вовремя. Клиент попробует подключиться снова.'),
};
export async function membership<T = unknown>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  if (!window.desktop?.membership) throw Error(t('Подключение доступно в десктопном приложении.'));
  const result = await window.desktop.membership(action, input);
  if (result.error) throw Object.assign(Error(errors[result.error.code]?.() || t('Не удалось выполнить действие ({0}).', result.error.code)), { code: result.error.code });
  return result.value as T;
}
export function effectiveProfile(state: ServerState, original: string) { return state.bindings.find(binding => binding.source === original)?.target || original; }
export function profileFor(state: ServerState, original: string) { return state.profiles.find(profile => profile.id === effectiveProfile(state, original)); }
export function storedJSON<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
export const cursorKey = (server: string, channel: string) => `pawtalk.v2.read.${server}.${channel}`;
export const isServerMuted = (server: string) => Number(localStorage.getItem(`pawtalk.v2.mute.${server}`)) > Date.now();

export const channelMuteKey=(server:string,channel:string)=>`pawtalk.v2.mute-channel.${server}.${channel}`;
export const isChannelMuted=(server:string,channel:string)=>Number(localStorage.getItem(channelMuteKey(server,channel)))>Date.now();
export const notificationsMuted=(server:string,channel:string)=>isServerMuted(server)||isChannelMuted(server,channel);
