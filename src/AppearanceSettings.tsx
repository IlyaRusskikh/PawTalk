import { t } from './i18n';
import { Slider } from './Controls';
import { defaultTheme, themePresets, type Theme } from './theme';

export function AppearanceSettings({ theme, onChange }: { theme: Theme; onChange(theme: Theme): void }) {
  const colors: { key: Exclude<keyof Theme, 'radius' | 'fontSize' | 'messageSpacing'>; label: string }[] = [
    { key: 'accent', label: t("Акцентный цвет") }, { key: 'background', label: t("Основной фон") },
    { key: 'surface', label: t("Панели и окна") }, { key: 'sidebar', label: t("Боковая панель") },
    { key: 'chat', label: t("Фон чата") }, { key: 'text', label: t("Основной текст") },
    { key: 'muted', label: t("Второстепенный текст") }, { key: 'border', label: t("Границы и разделители") },
    { key: 'success', label: t("Успех и шифрование") }, { key: 'warning', label: t("Предупреждения") },
    { key: 'danger', label: t("Ошибки и отключение") }, { key: 'onAccent', label: t("Текст на акцентном фоне") },
    { key: 'shadow', label: t("Тени и затемнение") },
  ];
  return <section className="settings-card appearance-settings"><h1>{t("Оформление")}</h1><p className="settings-description">{t("Выберите готовую тему или настройте каждый элемент под себя.")}</p>
    <div className="theme-presets">{themePresets.map(preset => <button key={preset.name} type="button" className="theme-preset" aria-label={t(preset.name)} aria-pressed={Object.keys(defaultTheme).every(key => theme[key as keyof Theme] === preset[key as keyof Theme])} onClick={() => onChange({ ...preset })}>
      <span className="theme-sample" style={{ background: preset.background, borderColor: preset.accent }}><i style={{ background: preset.accent }}/><i style={{ background: preset.surface }}/><i style={{ background: preset.text }}/></span><span>{t(preset.name)}</span>
    </button>)}</div>
    <h2 className="appearance-section-title">{t("Палитра")}</h2><div className="form-grid theme-color-grid">{[0, 1].map(column => <div className="form-fields" key={column}>{colors.filter((_, index) => index % 2 === column).map(({ key, label }) => <label className="theme-color-field" key={key}><span>{label}</span><span className="theme-color-control"><input type="color" aria-label={label} value={theme[key]} onChange={event => onChange({ ...theme, [key]: event.target.value })}/><code>{theme[key].toUpperCase()}</code></span></label>)}</div>)}</div>
    <h2 className="appearance-section-title">{t("Размеры и интервалы")}</h2><div className="form-fields appearance-sliders">
      <Slider label={t("Размер текста")} value={theme.fontSize} min={12} max={18} format={`${theme.fontSize} px`} onChange={fontSize => onChange({ ...theme, fontSize })}/>
      <Slider label={t("Скругление элементов")} value={theme.radius} min={4} max={24} format={`${theme.radius} px`} onChange={radius => onChange({ ...theme, radius })}/>
      <Slider label={t("Интервал между сообщениями")} value={theme.messageSpacing} min={2} max={12} format={`${theme.messageSpacing} px`} onChange={messageSpacing => onChange({ ...theme, messageSpacing })}/>
    </div><button type="button" className="quiet" onClick={() => onChange({ ...defaultTheme })}>{t("Вернуть стандартные цвета")}</button>
  </section>;
}
