# PawTalk Server — Linux и Windows

**Server 0.10.1 / Manager 0.2.1 опубликованы.** Команды установки используют
подписанные релизы и настроенные публичные ключи из `manager/trust.json`.
Клиент выпускается отдельно как `client-v0.10.1`. [Процесс выпуска](RELEASING.md).

## Требования

- Один Linux VPS: Debian 12 или Ubuntu 24.04, amd64/arm64, root/sudo.
- Python 3.11+, OpenSSL 3, ca-certificates; Docker Engine и Compose plugin v2+.
- Для Windows x64 — отдельный EXE: [WINDOWS-SERVER.md](WINDOWS-SERVER.md). Docker/Python отдельно не нужны.
- Публичный IPv4, не меняющийся после установки. IPv6 пока не поддерживается.
- Не менее 1 ГиБ свободного диска плюс место для истории, образов и резервных копий.
- TCP `PORT`, TCP `PORT+1`, UDP `PORT+2` доступны участникам. По умолчанию
  18443/18444/18445. `PORT+3` слушает только loopback; наружу его не открывать.

Фаервол и API провайдера установщик не изменяет. Сохраните доступ по SSH и настройте
правила провайдера самостоятельно. Локальный healthcheck не доказывает внешний UDP.
Постоянный Windows-сервер использует нативные службы с общим Manager controller.
Встроенная временная комната Windows-клиента сохранена.

## Установка

Bootstrap запускается из **проверенного исходного checkout** с известными публичными
ключами `manager/trust.json`. Не выполняйте непроверенный `curl | sh`.
Установите базовые зависимости обычным пакетным менеджером ОС (`python3 openssl
ca-certificates`). Затем из checkout:

```sh
sudo python3 manager/pawtalkctl --lang ru install
```

Мастер подтверждает публичный IP, порт, сквозное шифрование, лимит истории,
автообновление сервера. Один ответ включает или отключает
обновление сервера и средства обслуживания вместе. Шифрование и автообновление
в мастере включены по умолчанию; Enter означает «да». Он показывает кандидата IP из двух
внешних сервисов. Каждый ответ проверяется сразу: неверный ввод переспрашивается,
а при включённом шифровании обязательно запрашивается SHA-256 key ID.
Принимаются `да/нет`, `yes/no`, `true/false`; регистр
и стандартные управляющие обёртки терминальной вставки нормализуются.
При отсутствии Docker предложит установку из официального
[репозитория Ubuntu](https://docs.docker.com/engine/install/ubuntu/) или
[репозитория Debian](https://docs.docker.com/engine/install/debian/).
Конфликтующие пакеты не удаляются автоматически. Firewall не меняется.

Bootstrap проверяет подписанный Manager bundle и передаёт управление установщику
**из этого bundle**. Server берётся отдельно по подписанному GHCR digest.
Первое приглашение и пароль выводятся в терминале один раз. Пароль не попадает
в обычные логи контейнера. Сохраните вывод приватно; не присылайте его в issues.
Если выдача пароля была прервана, администратор может получить его командой
`docker exec <room-container> /pawtalk serve initial-password`, пока он не прочитан,
или задать новый пароль через stdin командой `serve reset-password` и перезапустить комнату.

Повторный `pawtalkctl install` сохраняет данные и конфигурацию; не создаёт новую
комнату при повреждении существующих данных. Старые тестовые Swarm-установки не
мигрируются, их ресурсы установщик не удаляет и автоматически не присоединяет.

## Команды

После установки используется стабильный launcher `/usr/local/bin/pawtalkctl`:

```sh
sudo pawtalkctl --lang ru status
sudo pawtalkctl doctor
sudo pawtalkctl logs
sudo pawtalkctl update check
sudo pawtalkctl update now
sudo pawtalkctl manager check
sudo pawtalkctl manager now
sudo pawtalkctl backup create
sudo pawtalkctl backup list
sudo pawtalkctl backup restore backup-012345abcdef --yes
sudo pawtalkctl configure PAWTALK_CHAT_MAX_MB=256 --yes
sudo pawtalkctl uninstall --keep-data --yes
```

Имена backup в примерах — заполнители. `restore` и `uninstall` запрашивают
подтверждение в TTY; `--yes` — явное согласие для автоматизированного вызова.
Uninstall останавливает только собственную комнату и таймеры; сохраняет инструменты,
данные, конфигурацию и backup. Чужие контейнеры/тома не затрагиваются.

## Конфигурация

`/etc/pawtalk/config.env`, root 0600 — данные, **не shell-скрипт**. Изменения применяйте
через `configure`. Не помещайте сюда версию или image digest: ими владеет managed state.

| Поле | Значение |
|---|---|
| `PAWTALK_PUBLIC_IP` | Подтверждённый IPv4. Изменение существующей комнаты блокируется, поскольку IP закреплён сертификатом. |
| `PAWTALK_PORT` | 1024–65532, по умолчанию 18443. Смена порта существующей комнаты также блокируется, чтобы не менять приглашение незаметно. |
| `PAWTALK_E2EE` | `true`/`false`; мастер предлагает `true`. В файле без этого поля сохраняется прежний fallback `false`. |
| `PAWTALK_E2EE_KEY_ID` | SHA-256 ID ключа из клиента: 64 строчных hex. Обязателен при E2EE. **Секретный ключ на VPS не вводится.** |
| `PAWTALK_CHAT_MAX_MB` | 128 по умолчанию, 0 — без лимита, максимум 1048576 МиБ. При уменьшении старые сообщения могут быть вытеснены; сначала создаётся backup. |
| `PAWTALK_UPDATE_PROXY` | `true` по умолчанию: relay клиентских обновлений с кэшем одного EXE. |
| `PAWTALK_SERVER_AUTO_UPDATE` | Мастер предлагает `true` общим вопросом об автообновлении. В файле без поля — `false`. |
| `PAWTALK_MANAGER_AUTO_UPDATE` | Мастер записывает тот же ответ для средства обслуживания. В файле без поля — `false`. |
| `PAWTALK_BACKUP_KEEP` | 5 копий по умолчанию, 1–1000. Удаляются только собственные завершённые копии после успешной операции. |
| `PAWTALK_LANGUAGE` | `ru`/`en`; язык команды можно указать через `--lang`. |

Настройки каналов нет: выбирается последняя опубликованная SemVer-версия своего
семейства тегов (`server-v*` / `manager-v*`), включая выпуски с отметкой prerelease.
Черновики пропускаются; подпись и привязка манифеста к релизу проверяются.
Старые поля `PAWTALK_SERVER_CHANNEL` / `PAWTALK_MANAGER_CHANNEL` игнорируются
при чтении и удаляются при следующем сохранении конфигурации. При отключённом
автообновлении соответствующая линия не запрашивает GitHub по таймеру. Ручной
`update check`/`manager check` делает явную сетевую проверку.

## Данные, обновления и восстановление

- `/var/lib/pawtalk-manager/installed.json`: Server version/digest, Manager version,
  project/volume и проверяемая идентичность комнаты; отдельный журнал транзакции.
- `/opt/pawtalk/compose.server.yaml`: проверенный production-шаблон; host networking,
  один Go/LiveKit контейнер, UID/GID 65532, read-only rootfs, без capabilities/socket.
- Новый именованный volume `pawtalk-<id>` содержит TLS, пароль-хеш, SQLite и историю.
  Том остаётся тем же при обычном обновлении. Recovery создаёт новый restore volume,
  сохраняя исходный для ручного разбора.
- `/opt/pawtalk-manager/versions/<version>/`: проверенный код Manager; атомарные
  `current`/`previous`, независимый стабильный launcher. Не редактируйте эти файлы.
- `/var/backups/pawtalk/backup-<id>/`: согласованный tar данных, checksum и metadata;
  подписанный Server receipt и, при наличии, подписанный Manager bundle для восстановления инструментов.

Server update: verify → pre-pull → lock/journal → остановка → полный backup →
Compose replacement → health (API+LiveKit+локальный HTTPS) и TLS/invitation check → commit.
Звонок кратковременно прерывается. Неподдерживаемая схема данных блокируется.
Неуспешный запуск восстанавливает **образ и данные** из согласованной копии;
одного image rollback недостаточно для SQLite. После аварии журнал восстанавливается
следующей командой или health timer. Несовместимые необратимые миграции не поддержаны.

Manager update проверяет подпись, состав и хэши bundle, выполняет self-test, затем
переключает версию. Если итоговая Compose-конфигурация не меняется, сервер не
перезапускается. Изменение runtime проходит через backup/health/recovery.
Изменение стабильного launcher или удаление/замена trust root требует отдельного
обслуживания; обычный Manager update его отклоняет. Добавление ключей возможно через
bundle, подписанный уже доверенным Manager ключом. [Подписи](RELEASING.md#ключи-и-доверие).

Docker поднимает завершившийся контейнер через `unless-stopped`. Health timer отдельно
реагирует на длительный `unhealthy`: не более трёх рестартов с backoff, общий lock
исключает конкуренцию с update/backup. После исчерпания попыток нужен `doctor`.
Ошибка updater не является причиной остановки здорового сервера.

Для переноса backup на чистый поддерживаемый VPS установите базовые зависимости и
Docker/Compose, скопируйте **всю** директорию копии в `/var/backups/pawtalk/` (root 0700),
используйте доверенный checkout/ключи и выполните:

```sh
sudo python3 manager/pawtalkctl backup restore backup-012345abcdef --trust manager/trust.json --yes
```

Код Manager из копии проверяется подписью и устанавливается вместе с данными.
Сохранённый image/version сверяется с подписанным Server receipt; явное историческое
восстановление допускает возраст исходного манифеста, сохраняя проверку подписи.
Образы должны быть доступны по сохранённому digest. На старый IP должно указывать
новое размещение: произвольная смена IP/сертификата не поддерживается.
Локальная копия на том же диске не защищает от потери VPS — храните внешнюю копию.

Для локальной приёмки есть `--no-systemd`, `--root` и передача подписанных
`--server-manifest`, `--manager-manifest`, `--bundle`, `--trust`. Это не обход подписей.
`tests/compose_integration.py` использует отдельный локальный registry и тестовые ключи.

## English

Server 0.10.1 uses one Debian 12 / Ubuntu 24.04 amd64/arm64 host with Docker
Engine and Compose v2+, host networking and a persistent non-root Go/LiveKit room.
Permanent Windows hosting uses native services and the shared Manager controller; see [Windows setup](WINDOWS-SERVER.md). Temporary rooms inside the Windows client remain.
Start `sudo python3 manager/pawtalkctl --lang en install` from a trusted checkout
with configured public roots. The wizard verifies and runs the signed Manager
installer and independently verifies the Server digest. Production public roots are
configured, and signed Server/Manager releases are published.
The wizard validates each answer immediately and always requests the SHA-256 key ID
when E2EE is enabled; boolean case and terminal paste wrappers are normalized.
Encryption and automatic updates default to yes in the wizard. One automatic-update
answer controls both the server and its maintenance tool; yes/no, да/нет and
true/false are accepted. Existing configurations and omitted file fields retain
their previous defaults.
There is no update-channel setting: each component selects its latest published
SemVer tag, including prereleases, and verifies the signed release binding.
Obsolete Server/Manager channel fields are ignored and removed on the next config save.

Use `status`, `doctor`, `logs`, `configure`, `update check|now`, `manager check|now`,
`backup create|list|restore`, and `uninstall --keep-data`. Restore/uninstall require
confirmation. Server updates interrupt calls, back up the stopped room and recover
the image/data pair after failure. Manager-only changes preserve the running container
when effective runtime configuration is unchanged. Disabled automatic update lines
make no scheduled GitHub requests. E2EE accepts only a SHA-256 key ID on the VPS.
Preserve the original IP and full backup directory; fresh-host recovery verifies the
archived Manager signature. External TCP/UDP and real-device audio remain unverified.
