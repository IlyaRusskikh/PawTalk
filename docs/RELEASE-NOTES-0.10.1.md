# Client 0.10.1 / Manager 0.2.1 — 2026-11-12

Status: published previews. Server remains 0.10.1; historical component tags/assets are unchanged.

Previous feature release and server-first upgrade guidance: [0.10.0 release notes](RELEASE-NOTES-0.10.0.md).

Both tags point to verified commit `89c8fe1` and ran in parallel:

- [Client 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.10.1) · [tag CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43172017460)
- [Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1) · [tag CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43172017294)

Both release workflows passed Windows Server 2022/2025 and native Linux amd64/arm64. Downloaded installers, signed manifests and exact asset hashes were verified after publication.

Установите обновлённые Client и Manager. Установщик Manager сохраняет конфигурацию и данные; замена host/runtime временно прерывает звонок. Уже установленный Server 0.10.1 менять не требуется.

Install the updated Client and Manager. Manager setup preserves configuration/data; replacing the host/runtime briefly interrupts calls. An installed Server 0.10.1 needs no replacement.

## Русский

- Manager: служба LocalService может не разрешать SYNCHRONIZE даже администратору без включённой SeDebugPrivilege. Остановка использует права SCM, а завершение процесса в этом случае проверяется через read-only snapshot с таймаутом. Настройки, смена пароля и удаление используют исправленный путь; ошибки удаления показывают этап и код.
- Настройки видны с первого открытия из трея даже при скрытом startup window. Язык меняется и сохраняется без Apply, обновляет трей и не применяет несохранённые IP/порт/E2EE. Настройки ожидают краткий lock обслуживания.
- Client: preview — индикатор, а не решение об авторизации. Закладка пробует текущую сохранённую пару пароль/ключ даже при устаревшем locked; форма открывается после реального отказа сервера. Пара читается/сохраняется совместно, поздние ответы preview не портят обновлённый доступ. Имеющиеся данные подставляются в форму.

Регрессии используют настоящий Windows process ACL при отключённой debug-привилегии, скрытый native settings process, оба языка и actual Electron UI/IPC. Внешняя сеть и реальные микрофоны не подтверждаются синтетическими проверками.

## English

- Manager stops LocalService hosts using SCM rights without requiring debug privilege. When SYNCHRONIZE is denied, a bounded read-only process snapshot verifies exit. Settings, password reset and uninstall share this path; removal failures show their phase/code.
- Settings appear on the first hidden-process launch. Language changes persist immediately and update the tray while unrelated unsaved fields remain drafts. Interactive settings wait for brief maintenance locks.
- Client attempts the current saved password/key pair despite a stale locked preview; only actual credentials rejection opens sign-in. Paired storage reads/writes and preview invalidation prevent partial snapshots and stale cache replacement. Available saved fields are prefilled.

The patch does not recover a forgotten E2EE secret from its key ID. A new secret needs its matching SHA-256 ID; the server never stores the original secret. Published Server 0.10.1 remains the dependency for both components.
