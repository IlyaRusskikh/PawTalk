import { useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ConnectionHistory, HistoryPoint } from '../shared/connection-history.mjs';
import { Chart } from './ConnectionCharts';
import { Modal } from './Modal';
import { t, useLanguage } from './i18n';

export function ConnectionSummary({ history, delay, onDebug }: { history: ConnectionHistory; delay?: number; onDebug(): void }) {
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const language = useLanguage();
  const loss = snapshot.state === 'connected' && typeof snapshot.current.outgoingLoss === 'number' && Number.isFinite(snapshot.current.outgoingLoss) ? snapshot.current.outgoingLoss : undefined;
  const values = snapshot.rtt.flatMap(point => point.value === undefined ? [] : [point.value]);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  const number = (value?: number) => value === undefined ? '—' : t("{0} мс", Math.round(value));
  return <>
    <Chart title={t("Пинг до сервера")} unit={t("мс")} points={snapshot.rtt} now={snapshot.at} minimum={100} language={language}/>
    <dl>
      <div><dt>{t("Средняя задержка")}</dt><dd>{number(average)}</dd></div>
      <div><dt>{t("Последняя задержка")}</dt><dd>{number(delay)}</dd></div>
      <div><dt>{t("Потеря исходящих аудиопакетов")}</dt><dd>{loss === undefined ? '—' : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(loss)} %`}</dd></div>
    </dl>
    <p className="connection-summary-help">{snapshot.state === 'reconnecting' || snapshot.state === 'signalReconnecting' ? t("Связь прервана. Ожидаем восстановления.") : !values.length ? t("Ожидание измерений") : t("Высокая задержка и потери пакетов могут вызывать прерывания голоса.")}</p>
    <button type="button" className="secondary connection-debug-button" onClick={onDebug}>{t("Отладка")}</button>
  </>;
}

export function ConnectionDebug({ history, delay, loss, onClose }: { history: ConnectionHistory; delay?: number; loss?: number; onClose(): void }) {
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const language = useLanguage();
  const [tab, setTab] = useState(0);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = [t("Передача данных"), t("Исходящие")];
  const format = (value: unknown, unit = '', factor = 1) => {
    if (typeof value === 'string') return value === 'yes' ? t("Да") : value === 'no' ? t("Нет") : value;
    if (typeof value !== 'number' || !Number.isFinite(value)) return t("Недоступно");
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value * factor)}${unit ? ' ' + unit : ''}`;
  };
  const metric = (key: string, label: string, unit = '', factor = 1, graph = false, provided?: HistoryPoint[], current?: number) => {
    const audio = key === 'audioLevel';
    const value = snapshot.state === 'connected' ? (provided ? current : snapshot.current[key]) : undefined;
    if (!(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && value.trim())) return null;
    const points = (provided ?? snapshot.series[key] ?? []).map(point => ({ ...point, value: point.value === undefined ? undefined : audio ? (point.value === 0 ? -100 : Math.max(-100, 20 * Math.log10(point.value))) : point.value * factor }));
    return <section className="rtc-metric" key={key} data-metric={key}>
      <div className="rtc-metric-value"><h3>{label}</h3><span>{audio && value === 0 ? '−∞ dB' : format(audio && typeof value === 'number' ? 20 * Math.log10(value) : value, unit, factor)}</span></div>
      {graph && <Chart title={label} unit={unit} points={points} now={snapshot.at} minimum={audio ? 0 : key === 'rtt' ? 100 : 1} floor={audio ? -100 : 0} language={language} showCaption={false}/>}
    </section>;
  };
  const metrics = tab === 0 ? [
    metric('availableBitrate', t("Доступный исходящий битрейт"), t("Кбит/с"), .001, true),
    metric('rtt', t("Пинг до сервера"), t("мс"), 1, true, snapshot.rtt, delay),
    metric('localAddress', t("Локальный адрес")),
    metric('protocol', t("Протокол")),
    metric('loss', t("Потеря входящих аудиопакетов"), '%', 1, true, snapshot.loss, loss),
    metric('transportPacketsReceived', t("Получено пакетов"), '', 1, true),
    metric('transportPacketsSent', t("Отправлено пакетов"), '', 1, true),
    metric('transportBytesReceived', t("Получено байт"), 'KB', .001, true),
    metric('transportBytesSent', t("Отправлено байт"), 'KB', .001, true)
  ] : [
    metric('ssrc', 'SSRC'),
    metric('codec', t("Кодек")),
    metric('audioDetected', t("Обнаружен звук")),
    metric('sampleRate', t("Частота кодека"), t("кГц"), .001),
    metric('audioLevel', t("Уровень аудио"), 'dB', 1, true),
    metric('bitrate', t("Битрейт"), t("Кбит/с"), .001, true),
    metric('targetBitrate', t("Целевой битрейт"), t("Кбит/с"), .001, true),
    metric('bytesSent', t("Отправлено байт"), 'KB', .001, true),
    metric('packetsLost', t("Потеряно пакетов"), '', 1, true),
    metric('packetsSent', t("Отправлено пакетов"), '', 1, true)
  ];
  return <Modal title={t("Отладка соединения")} className="connection-debug-modal" onClose={onClose}>
    <div className="rtc-layout">
      <aside className="rtc-sidebar">
        <strong>PawTalk</strong><small>{snapshot.state === 'connected' ? t("На связи") : snapshot.state === 'reconnecting' || snapshot.state === 'signalReconnecting' ? t("Переподключение") : t("Нет соединения")}</small>
        <div role="tablist" aria-label={t("Статистика WebRTC")} aria-orientation="vertical">{labels.map((label, index) => <button key={index} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel`} aria-selected={tab === index} tabIndex={tab === index ? 0 : -1} ref={node => { tabs.current[index] = node; }} onClick={() => setTab(index)} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
          setTab(next); tabs.current[next]?.focus();
        }}>{label}</button>)}</div>
      </aside>
      <div className="rtc-content" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
        <h2>{labels[tab]}{tab === 1 && <span>Audio</span>}</h2>
        <div className="rtc-metrics">{metrics}</div>
        {metrics.every(item => item === null) && <p className="rtc-note">{t("Ожидание измерений")}</p>}
      </div>
    </div>
  </Modal>;
}
