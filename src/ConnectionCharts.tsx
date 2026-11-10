import { chartSegments, type HistoryPoint } from '../shared/connection-history.mjs';
import { t } from './i18n';

export function Chart({ title, unit, points, now, minimum, language, floor = 0, showCaption = true }: { title: string; unit: string; points: HistoryPoint[]; now: number; minimum: number; language: string; floor?: number; showCaption?: boolean }) {
  const maximum = Math.max(minimum, ...points.map(point => point.value ?? 0));
  const segments = chartSegments(points, now, maximum, 280, 58, floor);
  const format = (value: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
  return <figure className="connection-chart">
    {showCaption && <figcaption><span>{title}</span><span>{format(maximum)} {unit}</span></figcaption>}
    <svg viewBox="0 0 280 58" role="img" aria-label={t("{0}: последние 2 минуты, {1}", title, unit)}>
      <path className="connection-chart-grid" d="M0 1H280 M0 29H280 M0 57H280 M70 0V58 M140 0V58 M210 0V58"/>
      {segments.map((segment, index) => <g key={index}>
        <polyline points={segment.map(point => point.join(',')).join(' ')} />
        {segment.length === 1 && <circle cx={segment[0][0]} cy={segment[0][1]} r="2"/>}
      </g>)}
    </svg>
    {!segments.length && <span className="connection-chart-empty">{t("Нет измерений")}</span>}
    <div className="connection-chart-axis"><span>−2:00</span><span>−1:00</span><span>{t("Сейчас")}</span></div>
    <span className="connection-chart-zero">{format(floor)} {unit}</span>
  </figure>;
}
