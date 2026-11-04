const position = (db: number) => Math.max(0, Math.min(100, (db + 80) / 70 * 100));
export function SensitivityMeter({ db, threshold, speaking, available, automatic, onChange }: { db: number; threshold: number; speaking: boolean; available: boolean; automatic: boolean; onChange: (value: number) => void }) {
  const boundary = position(threshold);
  return <div className={`sensitivity ${speaking && available ? 'is-speaking' : ''}`} data-speaking={speaking && available} data-threshold={threshold}>
    <div className="sensitivity-track" role="meter" aria-label="Уровень относительно порога" aria-valuemin={-80} aria-valuemax={-10} aria-valuenow={Math.max(-80, Math.min(-10, Math.round(db)))} aria-valuetext={`Уровень ${Math.round(db)} dBFS; порог ${Math.round(threshold)} dBFS`}>
      <div className="sensitivity-zones" style={{ background: `linear-gradient(to right, #b58745 0%, #b58745 ${boundary}%, #379669 ${boundary}%, #379669 100%)` }}/>
      <div className="sensitivity-level" style={{ width: `${available ? position(db) : 0}%` }}/>
      {!automatic && <input aria-label="Порог активации" aria-valuetext={`${Math.round(threshold)} dBFS`} title={`${Math.round(threshold)} dBFS`} type="range" min={-80} max={-10} step={1} value={threshold} onChange={event => onChange(Number(event.target.value))}/>}
    </div>
  </div>;
}
