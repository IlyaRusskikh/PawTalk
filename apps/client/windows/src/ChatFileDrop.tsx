import { useEffect, useEffectEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Controls';
import { t } from './i18n';

export function ChatFileDrop({ channelName, enabled, onFiles }: {
  channelName: string; enabled: boolean; onFiles(files: File[]): void;
}) {
  const [dragging, setDragging] = useState(false);
  const addFiles = useEffectEvent(onFiles);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const available = () => enabled && !document.querySelector('dialog[open]');
    const reset = () => { depth = 0; setDragging(false); };
    const enter = (event: DragEvent) => {
      if (!hasFiles(event) || !available()) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!available()) {
        event.dataTransfer!.dropEffect = 'none';
        reset();
        return;
      }
      event.dataTransfer!.dropEffect = 'copy';
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth || event.target === document.documentElement) reset();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
      if (available()) addFiles(Array.from(event.dataTransfer!.files));
    };
    reset();
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('blur', reset);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('dragend', reset);
    };
  }, [enabled]);

  return enabled && dragging && createPortal(<div className="chat-file-drop-overlay" role="status">
    <div className="chat-file-drop-card">
      <Icon name="image" size={72}/>
      <strong>{t('Загрузить в «{0}»', channelName)}</strong>
      <span>{t('Добавьте комментарий к файлам перед отправкой.')}</span>
    </div>
  </div>, document.body);
}
