import { Icon } from './Controls';
import { t } from './i18n';
import { Button } from './ui/Button';
import './chat-empty-state.css';

export function ChatEmptyState({ onCompose }: { onCompose?: () => void }) {
  return <section className="chat-empty-state">
    <div className="chat-empty-art" aria-hidden="true">
      <i className="chat-empty-orbit chat-empty-orbit-wide"/>
      <i className="chat-empty-orbit chat-empty-orbit-round"/>
      <i className="chat-empty-spark chat-empty-spark-first"/>
      <i className="chat-empty-spark chat-empty-spark-second"/>
      <span className="chat-empty-art-tile"><Icon name="paw" size={34}/></span>
      <span className="chat-empty-art-bubble"><i/><i/><i/></span>
    </div>
    <h2>{t('Здесь пока тихо')}</h2>
    {onCompose ? <>
      <p>{t('Если захочется начать разговор, достаточно простого «привет».')}</p>
      <Button type="button" variant="quiet" onClick={onCompose}>
        <Icon name="chat" size={17}/>{t('Написать сообщение')}
      </Button>
    </> : <p>{t('В этом чате пока нет сообщений.')}</p>}
  </section>;
}
