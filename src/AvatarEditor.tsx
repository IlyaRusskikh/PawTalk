import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { avatarFileLimit, avatarFormats, drawAvatar, encodeAvatar, type AvatarCrop } from './avatarImage';
import { Modal } from './Modal';
import { t } from './i18n';

const initialCrop: AvatarCrop = { zoom: 1, x: 0.5, y: 0.5 };
const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function AvatarEditor({ file, onClose, onSave }: { file: File; onClose(): void; onSave(value: string): boolean }) {
  const [image, setImage] = useState<ImageBitmap>();
  const [crop, setCrop] = useState(initialCrop);
  const [error, setError] = useState<'file' | 'save'>();
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; crop: AvatarCrop } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | undefined;
    if (!avatarFormats.includes(file.type) || file.size > avatarFileLimit) {
      setError('file');
      return;
    }
    void createImageBitmap(file).then(decoded => {
      if (cancelled || decoded.width * decoded.height > 32_000_000) {
        decoded.close();
        if (!cancelled) setError('file');
        return;
      }
      bitmap = decoded;
      setImage(bitmap);
    }).catch(() => { if (!cancelled) setError('file'); });
    return () => { cancelled = true; bitmap?.close(); };
  }, [file]);

  useLayoutEffect(() => {
    if (image && preview.current) drawAvatar(preview.current, image, crop);
  }, [image, crop]);

  return <Modal title={t("Настроить аватар")} className="avatar-editor" onClose={onClose}>
    <div className="form-fields">
      {image && <>
        <canvas ref={preview} width={256} height={256} className="avatar-crop-preview" tabIndex={0}
          aria-label={t("Область кадрирования аватара")}
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, crop };
          }}
          onPointerMove={event => {
            const start = drag.current;
            if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const size = Math.min(image.width, image.height) / start.crop.zoom;
            const scale = size / event.currentTarget.getBoundingClientRect().width;
            setCrop({
              zoom: start.crop.zoom,
              x: clamp(start.crop.x - (event.clientX - start.x) * scale / Math.max(1, image.width - size)),
              y: clamp(start.crop.y - (event.clientY - start.y) * scale / Math.max(1, image.height - size)),
            });
          }}
          onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={event => {
            const dx = event.key === 'ArrowLeft' ? 0.05 : event.key === 'ArrowRight' ? -0.05 : 0;
            const dy = event.key === 'ArrowUp' ? 0.05 : event.key === 'ArrowDown' ? -0.05 : 0;
            if (!dx && !dy) return;
            event.preventDefault();
            setCrop(current => ({ ...current, x: clamp(current.x + dx), y: clamp(current.y + dy) }));
          }}/>
        <p className="avatar-crop-help">{t("Перетащите изображение или используйте стрелки, чтобы выбрать область.")}</p>
        <label>{t("Масштаб")}<input type="range" min={1} max={4} step={0.05} value={crop.zoom} onChange={event => setCrop(current => ({ ...current, zoom: Number(event.target.value) }))}/></label>
      </>}
      {!image && !error && <p role="status">{t("Открываем изображение…")}</p>}
      {error && <p className="text-error" role="alert">{error === 'file'
        ? t("Не удалось открыть изображение. Выберите PNG, JPEG или WebP до 10 МБ и 32 Мп.")
        : t("Не удалось сохранить аватар.")}</p>}
    </div>
    <div className="modal-actions">
      <button type="button" className="quiet" onClick={onClose}>{t("Отмена")}</button>
      <button type="button" className="primary" disabled={!image} onClick={() => {
        const data = image && encodeAvatar(image, crop);
        if (data && onSave(data)) onClose();
        else setError('save');
      }}>{t("Сохранить")}</button>
    </div>
  </Modal>;
}
