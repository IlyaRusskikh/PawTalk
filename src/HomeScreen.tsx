import './home.css';
import { Icon } from './Controls';
import type { Bookmark } from './BookmarkRail';
import { t } from './i18n';

export function HomeScreen({ hosting, disabled, bookmarks, roomName, inRoom, onJoin, onHost, onOpen, onReturn, onServerKey }: {
  hosting: boolean; disabled: boolean; bookmarks: Bookmark[]; roomName: string; inRoom: boolean;
  onJoin(): void; onHost(): void; onOpen(item: Bookmark): void; onReturn(): void; onServerKey(): void;
}) {
  return <section className="home-screen" aria-labelledby="home-title">
    <div className="home-masthead"><span><img src="./pawtalk.svg" alt="" width="21" height="21"/>PawTalk</span><span className="home-masthead-note">{t("Ваше пространство для общения")}</span></div>
    <div className="home-hero"><div className="home-intro"><div className="eyebrow">{t("СОБИРАЙТЕСЬ БЛИЖЕ")}</div><h1 id="home-title">{t("Разговор начинается здесь.")}</h1><p>{t("Для вечеров с друзьями, общих планов и разговоров без спешки. Выберите комнату — и вы уже рядом.")}</p></div>
      <div className="home-art" aria-hidden="true"><div className="home-orbit home-orbit-one"/><div className="home-orbit home-orbit-two"/><div className="home-art-avatar"><Icon name="headphones" size={37}/></div><div className="home-art-wave">{[12, 22, 35, 18, 44, 29, 16, 34, 23, 11].map((height, index) => <i key={index} style={{ height }}/>)}</div><span className="home-art-dot home-art-dot-one"/><span className="home-art-dot home-art-dot-two"/></div>
    </div>
    {inRoom && <button className="return-room" onClick={onReturn}><span className="home-live-dot"/>{t("Вернуться в комнату: {0}", roomName)}<Icon name="chevron-right" size={17}/></button>}
    <div className="home-actions">
      <button className="home-action home-action-join" disabled={disabled} onClick={onJoin}><span className="home-action-icon"><Icon name="signal" size={26}/></span><strong>{t("Присоединиться к комнате")}</strong><span className="home-action-kicker">{t("ВАС УЖЕ ЖДУТ")}</span><span className="home-action-description">{t("Вставьте приглашение и возвращайтесь к своим.")}</span><span className="home-action-bottom"><span>{t("По адресу сервера или приглашению")}</span><Icon name="chevron-right" size={21}/></span></button>
      <button className="home-action home-action-create" disabled={disabled} onClick={onHost}><span className="home-action-icon"><Icon name="invite" size={26}/></span><strong>{hosting ? t("Моя комната") : t("Создать комнату")}</strong><span className="home-action-kicker">{hosting ? t("ВАША КОМНАТА ОТКРЫТА") : t("СОБЕРИТЕ СВОИХ")}</span><span className="home-action-description">{hosting ? t("Вернитесь в комнату или пригласите друзей.") : t("Начните разговор и отправьте друзьям приглашение.")}</span><span className="home-action-bottom"><span>{hosting ? t("Комната работает") : t("На вашем компьютере")}</span><Icon name="chevron-right" size={21}/></span></button>
    </div>
    {bookmarks.length > 0 && <section className="home-saved"><div className="home-section-label"><h2>{t("Ваши комнаты")}</h2><span>{t("Быстрый доступ")}</span></div><div className="home-saved-list">{bookmarks.slice(0, 4).map(item => <button key={item.address} disabled={disabled} onClick={() => onOpen(item)}><span>{item.name.slice(0, 1).toUpperCase()}</span><strong>{item.name}</strong><Icon name="chevron-right" size={15}/></button>)}</div></section>}
    <div className="server-setup"><span className="home-setup-icon"><Icon name="settings" size={17}/></span><div><strong>{t("Своя постоянная комната?")}</strong><span>{t("Подготовьте ключ для отдельного сервера.")}</span></div><button className="e2ee-generate" onClick={onServerKey}>{t("Сгенерировать ключ шифрования")}<Icon name="chevron-right" size={14}/></button></div>
  </section>;
}
