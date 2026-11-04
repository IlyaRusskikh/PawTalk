import { readFile, writeFile } from 'node:fs/promises';
const report = JSON.parse(await readFile('release/qa/e2ee-benchmark.json','utf8'));
const average = values => values.reduce((sum,n)=>sum+n,0)/values.length;
const quantile = (values,q) => { const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]; };
const f = value => value.toFixed(2);
let text = `# Эксперимент E2EE: измерения\n\nДата: ${report.date}. Процессор: ${report.cpuModel}, ${report.cpus} логических CPU. Electron ${report.versions.electron}, Chromium ${report.versions.chrome}. Источник: ${report.source}.\n\n${report.notes.map(note=>'- '+note).join('\n')}\n\nДва прогона на каждый режим, ${report.secondsPerTrial} секунд каждый. CPU в таблицах: 100% = одно логическое ядро. Задержки — объединённые измерительные окна обоих направлений двух прогонов.\n\n`;
const summaries = [];
text += 'Тестовые окна используют production VoiceSession без полного интерфейса; аппаратное ускорение Electron выключено. Абсолютная загрузка готового приложения может отличаться.\n\n';
for (const noise of [...new Set(report.trials.map(t=>t.noise))]) {
 const summarize = encrypted => {
  const trials = report.trials.filter(t=>t.noise===noise&&t.encrypted===encrypted);
  const delays = trials.flatMap(t=>t.latencies);
  return {rendererCPU:average(trials.flatMap(t=>t.clientRendererCPU)),totalCPU:average(trials.map(t=>t.electronTotalCPU)),p50:quantile(delays,.5),p95:quantile(delays,.95),markers:delays.length};
 };
 const off=summarize(false),on=summarize(true);
 const delta={rendererCPU:on.rendererCPU-off.rendererCPU,totalCPU:on.totalCPU-off.totalCPU,p50:on.p50-off.p50,p95:on.p95-off.p95};
 summaries.push({noise,off,on,delta});
 text += `## ${noise==='rnnoise'?'RNNoise включён':'Шумоподавление выключено'}\n\n| Метрика | Без E2EE | С E2EE | Разница |\n| --- | ---: | ---: | ---: |\n| CPU процесса renderer одного клиента, % ядра | ${f(off.rendererCPU)} | ${f(on.rendererCPU)} | ${f(delta.rendererCPU)} п.п. |\n| CPU всех процессов Electron двух клиентов, % ядра | ${f(off.totalCPU)} | ${f(on.totalCPU)} | ${f(delta.totalCPU)} п.п. |\n| То же, % всего CPU (${report.cpus} потоков) | ${f(off.totalCPU/report.cpus)} | ${f(on.totalCPU/report.cpus)} | ${f(delta.totalCPU/report.cpus)} п.п. |\n| Программная задержка p50, мс | ${f(off.p50)} | ${f(on.p50)} | ${f(delta.p50)} |\n| Программная задержка p95, мс | ${f(off.p95)} | ${f(on.p95)} | ${f(delta.p95)} |\n| Измерительных окон | ${off.markers} | ${on.markers} | — |\n\n`;
}
const drift = Math.max(...report.trials.flatMap(t=>t.clockOffsetDriftMs).map(Math.abs));
text += `Максимальный дрейф калибровки аудиочасов за прогон: ${f(drift)} мс.\n\nПроверки безопасности: ${report.security.join('; ') || 'не запускались в этом прогоне'}. Реальный чекбокс, production IPC, worker из production-сборки и защищённое сохранение ключа проверяет отдельная команда \`node scripts/e2ee-main-smoke.mjs\`.\n\nЭто локальное сравнение двух клиентов, не нагрузочное испытание большой комнаты и не измерение реальных устройств или интернета. Отрицательная небольшая разница задержки означает вариацию между прогонами, а не ускорение за счёт шифрования. Оценивать стоимость E2EE следует вместе с разбросом отдельных прогонов.\n\nПовторить: \`node scripts/e2ee-benchmark.mjs\`, затем \`node scripts/summarize-e2ee.mjs\`. Исходные числа: \`release/qa/e2ee-benchmark.json\`.\n`;
await writeFile('release/qa/e2ee-benchmark.md',text);
console.log(JSON.stringify({cpu:report.cpuModel,cpus:report.cpus,summaries,maxClockDriftMs:drift},null,2));
