import { Icon } from './Controls';
import { t } from './i18n';
import './home.css';

export function HomeScreen({ hosting, disabled, onJoin, onHost }: {
  hosting: boolean;
  disabled: boolean;
  onJoin(): void;
  onHost(): void;
}) {
  return <section className="home-screen" aria-labelledby="home-title">
    <div className="home-masthead"><span><Icon name="paw" size={21}/>PawTalk</span><span className="home-masthead-note">{t('Ваше пространство для общения')}</span></div>
    <div className="home-hero">
      <div className="home-intro"><div className="eyebrow">{t('СОБИРАЙТЕСЬ БЛИЖЕ')}</div><h1 id="home-title">{t('Разговор начинается здесь.')}</h1><p>{t('Для вечеров с друзьями, общих планов и разговоров без спешки.')}<br/>{t('Ваши серверы, чаты и голос — в одном месте.')}</p></div>
      <div className="home-art" aria-hidden="true"><div className="home-orbit home-orbit-one"/><div className="home-orbit home-orbit-two"/><div className="home-art-avatar"><Icon name="headphones" size={37}/></div><div className="home-art-wave">{[12, 22, 35, 18, 44, 29, 16, 34, 23, 11].map((height, index) => <i key={index} style={{ height }}/>)}</div><span className="home-art-dot home-art-dot-one"/><span className="home-art-dot home-art-dot-two"/></div>
    </div>
    <div className="home-actions">
      <button type="button" className="home-action home-action-join" disabled={disabled} onClick={onJoin}><span className="home-action-top"><span className="home-action-icon"><Icon name="signal" size={26}/></span><span className="home-action-kicker">{t('ВАС УЖЕ ЖДУТ')}</span></span><strong>{t('Присоединиться к серверу')}</strong><span className="home-action-description">{t('Вставьте приглашение и возвращайтесь к своим.')}</span><span className="home-action-bottom"><span>{t('По приглашению или строке привязки')}</span><Icon name="chevron-right" size={21}/></span></button>
      <button type="button" className="home-action home-action-create" disabled={disabled} onClick={onHost}><span className="home-action-top"><span className="home-action-icon"><Icon name="invite" size={26}/></span><span className="home-action-kicker">{hosting ? t('ВАШ СЕРВЕР РАБОТАЕТ') : t('СОБЕРИТЕ СВОИХ')}</span></span><strong>{hosting ? t('Мой сервер') : t('Создать сервер')}</strong><span className="home-action-description">{hosting ? t('Управляйте сервером и приглашайте друзей.') : t('Начните разговор и отправьте друзьям приглашение.')}</span><span className="home-action-bottom"><span>{hosting ? t('Управление и приглашения') : t('На вашем компьютере')}</span><Icon name="chevron-right" size={21}/></span></button>
    </div>
    <div className="home-details">
      <div><Icon name="chat" size={19}/><div><strong>{t('Общение продолжается')}</strong><p>{t('Переключайтесь между чатами и голосовыми каналами на своих серверах.')}</p></div></div>
      <div><Icon name="invite" size={19}/><div><strong>{t('Свои всегда рядом')}</strong><p>{t('Добавленные серверы остаются на панели слева. Возвращайтесь одним нажатием.')}</p></div></div>
    </div>
  </section>;
}
