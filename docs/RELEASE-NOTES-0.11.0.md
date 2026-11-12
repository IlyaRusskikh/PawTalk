# Client 0.11.0 — preview

Client 0.11.0 выпускается по разрешению владельца тегом `client-v0.11.0`.
Server остаётся 0.10.1, Manager 0.2.1. Существующие ссылки загрузок сохраняются
до успешной публикации новых assets. Полные двуязычные заметки
выпуска: [client-v0.11.0](releases/client-v0.11.0.md).

Client 0.11.0 is released with the owner-authorized `client-v0.11.0` tag. Server
remains 0.10.1 and Manager 0.2.1. Existing download links remain until the new
assets are successfully published. See the linked bilingual release notes.

Локально проверены build, unit, native Electron UI, RU/EN, normal/reduced motion,
clipboard, shared-core identity, Go tests/vet, два синтетических аудиоклиента,
Docker lifecycle и packaged smoke. Это не приёмка физических микрофонов,
внешней сети, нагрузок, Windows CI runners или native Linux arm64.

Local checks covered build/unit, native Electron UI, language/motion/clipboard,
shared-core identity, Go tests/vet, two synthetic-audio peers, Docker lifecycle
and packaged smoke. Physical devices, external networks, load, Windows CI runners
and native Linux arm64 remain separate acceptance; local success does not guarantee CI.
