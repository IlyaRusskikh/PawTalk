# Client 0.10.1 / Manager 0.2.1 — patch in preparation

Status: unpublished. Server remains 0.10.1; historical component tags/assets are unchanged.

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
