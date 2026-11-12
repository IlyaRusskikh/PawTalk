# Client 0.11.0 — preview

Client 0.11.0 опубликован тегом `client-v0.11.0`; скачанные assets проверены.
Server остаётся 0.10.1, Manager 0.2.1. Ссылки загрузок обновлены после
успешной публикации новых assets. Полные двуязычные заметки
выпуска: [client-v0.11.0](releases/client-v0.11.0.md).

Client 0.11.0 is published with the `client-v0.11.0` tag; downloaded assets were
verified. Server remains 0.10.1 and Manager 0.2.1. Download links were updated
after successful publication. See the linked bilingual release notes.

Локально проверены build, unit, native Electron UI, RU/EN, normal/reduced motion,
clipboard, shared-core identity, Go tests/vet, два синтетических аудиоклиента,
Docker lifecycle и packaged smoke. Это не приёмка физических микрофонов,
внешней сети, нагрузок, Windows CI runners или native Linux arm64.

Local checks covered build/unit, native Electron UI, language/motion/clipboard,
shared-core identity, Go tests/vet, two synthetic-audio peers, Docker lifecycle
and packaged smoke. Physical devices, external networks, load, Windows CI runners
and native Linux arm64 remain separate acceptance; local success does not guarantee CI.

[Выпускной CI / Release-tag CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43214973146)
успешен: Windows 2022/2025 и Linux amd64/arm64. Это отдельная проверка, не локальный
запуск. / Passed on Windows 2022/2025 and Linux amd64/arm64; these are separate CI
results, not local checks.
