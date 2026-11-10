import { useSyncExternalStore } from 'react';
import { chartSegments, type ConnectionHistory, type HistoryPoint } from '../shared/connection-history.mjs';
import { pingLevel } from '../shared/ping.mjs';
import { t, useLanguage } from './i18n';

function Chart({ title, unit, points, now, minimum, language }: { title: string; unit: string; points: HistoryPoint[]; now: number; minimum: number; language: string }) {
  const maximum = Math.max(minimum, ...points.map(point => point.value ?? 0));
  const segments = chartSegments(points, now, maximum);
  const format = (value: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
  return <figure className="connection-chart">
    <figcaption><span>{title}</span><span>{format(maximum)} {unit}</span></figcaption>
    <svg viewBox="0 0 280 58" role="img" aria-label={t("{0}: последние 2 минуты, {1}", title, unit)}>
      <path className="connection-chart-grid" d="M0 1H280 M0 29H280 M0 57H280 M70 0V58 M140 0V58 M210 0V58"/>
      {segments.map((segment, index) => <g key={index}>
        <polyline points={segment.map(point => point.join(',')).join(' ')} />
        {segment.length === 1 && <circle cx={segment[0][0]} cy={segment[0][1]} r="2"/>}
      </g>)}
    </svg>
    {!segments.length && <span className="connection-chart-empty">{t("Нет измерений")}</span>}
    <div className="connection-chart-axis"><span>−2:00</span><span>−1:00</span><span>{t("Сейчас")}</span></div>
    <span className="connection-chart-zero">0 {unit}</span>
  </figure>;
}

export function ConnectionCharts({ history, delay, loss }: { history: ConnectionHistory; delay?: number; loss?: number }) {
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const language = useLanguage();
  const level = pingLevel(delay);
  const reconnecting = snapshot.state === 'reconnecting' || snapshot.state === 'signalReconnecting';
  const qualityLevel = reconnecting || level === 'bad' || (loss ?? 0) >= 10 ? 'bad'
    : level === 'warning' || (loss ?? 0) >= 3 ? 'warning' : level;
  const status = reconnecting ? t("Переподключение") : snapshot.state !== 'connected' ? t("Нет соединения")
    : delay === undefined && loss === undefined ? t("Ожидание измерений")
    : level === 'bad' || (loss ?? 0) >= 10 ? t("Плохое соединение")
    : level === 'warning' || (loss ?? 0) >= 3 ? t("Нестабильное соединение") : t("Хорошее соединение");
  return <>
    <p className={`connection-quality ping-${qualityLevel}`}><i/>{status}</p>
    <Chart title={t("Пинг до сервера")} unit={t("мс")} points={snapshot.rtt} now={snapshot.at} minimum={100} language={language}/>
    <Chart title={t("Потеря входящих аудиопакетов")} unit="%" points={snapshot.loss} now={snapshot.at} minimum={5} language={language}/>
    <small className="connection-history-note">{reconnecting ? t("Связь прервана. Ожидаем восстановления.") : t("Последние 2 минуты · разрывы означают отсутствие данных")}</small>
  </>;
}
