# Client 0.11.0 — подготовка / preparation

Ветка client-0.11.0, выпуск не опубликован. Server остаётся 0.10.1, Manager 0.2.1.
Публикация Client требует отдельного тега и разрешения. Существующие загрузки
остаются на опубликованном Client 0.10.1. Полные двуязычные заметки будущего
выпуска: [client-v0.11.0](releases/client-v0.11.0.md).

The client-0.11.0 branch prepares an unpublished Client release. Server remains
0.10.1 and Manager 0.2.1. Publishing requires a separately authorized tag; existing
download links still point to published Client 0.10.1. See the linked bilingual notes.

Локально проверены build, unit, native Electron UI, RU/EN, normal/reduced motion,
clipboard, shared-core identity, Go tests/vet, два синтетических аудиоклиента,
Docker lifecycle и packaged smoke. Это не приёмка физических микрофонов,
внешней сети, нагрузок, Windows CI runners или native Linux arm64.

Local checks covered build/unit, native Electron UI, language/motion/clipboard,
shared-core identity, Go tests/vet, two synthetic-audio peers, Docker lifecycle
and packaged smoke. Physical devices, external networks, load, Windows CI runners
and native Linux arm64 remain separate acceptance; local success does not guarantee CI.
