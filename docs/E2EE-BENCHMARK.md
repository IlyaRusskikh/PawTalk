# Эксперимент E2EE: измерения

Это историческая серия до объединения AudioContext. Более поздняя оптимизация задержки и уточнение входной точки измерения описаны в [LATENCY.md](LATENCY.md); приведённые ниже абсолютные задержки не описывают обновлённый аудиотракт.

В этой серии E2EE увеличило CPU renderer одного клиента на **2,87 п.п. одного логического ядра без шумоподавления** и на **6,45 п.п. с RNNoise**. Для восьмипоточного CPU это около 0,36 и 0,81 п.п. общей загрузки CPU соответственно, без учёта общих служебных процессов Electron. Полный набор процессов Electron с двумя клиентами вырос с 4,12% до 4,82% всего CPU без шумоподавления и с 9,12% до 10,77% с RNNoise.

Изменение медианной программной задержки: −2,67 мс без шумоподавления и +2,67 мс с RNNoise — один шаг измерения. Между отдельными прогонами разброс был больше. Устойчивого ухудшения задержки эта серия не показала; нулевые накладные расходы из неё не следуют. Режим оставлен экспериментальным и выключенным по умолчанию.

Дата: 2026-11-04T11:46:16.692Z. Процессор: 12th Gen Intel(R) Core(TM) i3-12100F, 8 логических CPU. Electron 45.2.1, Chromium 156.0.8078.75. Источник: locally synthesized SAPI speech.

- Two simultaneous clients on one Windows computer; Linux LiveKit in Docker Desktop.
- CPU 100% = one logical core. Renderer CPU includes its E2EE worker; total includes main/audio/GPU utility processes for both clients.
- Latency: fake microphone speech capture tap to remote decoded playback gain tap, AudioContext output timestamp calibration. Excludes physical microphone/speaker and internet propagation.
- Envelope cross-correlation in non-overlapping two-second windows, lag search 0..501 ms; minimum Pearson correlation 0.5. Resolution 128/48000 seconds (~2.67 ms). Small differences within jitter/resolution are inconclusive.
- ABBA order per noise mode; six-second warmup plus 1.5-second meter clock warmup; no gaming load.
- LiveKit disables audio RED for E2EE; the comparison measures the complete negotiated modes, not an isolated AES microbenchmark.

Два прогона на каждый режим, 24 секунд каждый. CPU в таблицах: 100% = одно логическое ядро. Задержки — объединённые измерительные окна обоих направлений двух прогонов.

Тестовые окна используют production VoiceSession без полного интерфейса; аппаратное ускорение Electron выключено. Абсолютная загрузка готового приложения может отличаться.

## RNNoise включён

| Метрика | Без E2EE | С E2EE | Разница |
| --- | ---: | ---: | ---: |
| CPU процесса renderer одного клиента, % ядра | 32.92 | 39.37 | 6.45 п.п. |
| CPU всех процессов Electron двух клиентов, % ядра | 72.95 | 86.16 | 13.21 п.п. |
| То же, % всего CPU (8 потоков) | 9.12 | 10.77 | 1.65 п.п. |
| Программная задержка p50, мс | 138.67 | 141.33 | 2.67 |
| Программная задержка p95, мс | 152.00 | 144.00 | -8.00 |
| Измерительных окон | 45 | 46 | — |

## Шумоподавление выключено

| Метрика | Без E2EE | С E2EE | Разница |
| --- | ---: | ---: | ---: |
| CPU процесса renderer одного клиента, % ядра | 13.05 | 15.92 | 2.87 п.п. |
| CPU всех процессов Electron двух клиентов, % ядра | 32.96 | 38.59 | 5.63 п.п. |
| То же, % всего CPU (8 потоков) | 4.12 | 4.82 | 0.70 п.п. |
| Программная задержка p50, мс | 114.67 | 112.00 | -2.67 |
| Программная задержка p95, мс | 120.00 | 122.67 | 2.67 |
| Измерительных окон | 44 | 45 | — |

Максимальный дрейф калибровки аудиочасов за прогон: 0.14 мс.

Проверки безопасности: container passed; embedded passed. Реальный чекбокс, production IPC, worker из production-сборки и защищённое сохранение ключа проверяет отдельная команда `node scripts/e2ee-main-smoke.mjs`.

Это локальное сравнение двух клиентов, не нагрузочное испытание большой комнаты и не измерение реальных устройств или интернета. Отрицательная небольшая разница задержки означает вариацию между прогонами, а не ускорение за счёт шифрования. Оценивать стоимость E2EE следует вместе с разбросом отдельных прогонов.

Повторить: `node scripts/e2ee-benchmark.mjs`, затем `node scripts/summarize-e2ee.mjs`. Исходные числа: `release/qa/e2ee-benchmark.json`.
