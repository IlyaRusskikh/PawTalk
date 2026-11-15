# Постоянный PawTalk Server API 2 на Linux VPS

Пошаговая установка опубликованных Server и Linux Manager с нуля. Windows-клиент
подключается к VPS; ставить Client, Node.js или Go на VPS не требуется.
Текущие версии и файлы берите из [каталога GitHub Releases](https://ilyarusskikh.github.io/PawTalk/downloads/),
а не из `package.json` и не из общего `/releases/latest`.

На 15 ноября 2026 года опубликована совместимая preview-комбинация:
[Server 0.11.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.11.1),
[Manager 0.5.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.5.1),
[Client 0.12.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.12.1).
Это справочная точка, а не пины установки: Manager обнаруживает актуальные релизы
своего семейства и проверяет подписи и API/data schema. Перед более поздними
обновлениями читайте [совместимость](COMPATIBILITY.md) и описания выбранных выпусков.

## 1. Подготовить чистый VPS

- **Debian 12 Bookworm или Ubuntu 24.04 LTS**, systemd, архитектура **amd64 или
  arm64**. Это поддерживаемые текущим Linux Manager дистрибутивы. Общие команды
  ниже подходят обоим; bootstrap сам выбирает официальный apt-репозиторий Docker
  для установленного дистрибутива. Другие версии и дистрибутивы (включая Debian 13),
  armhf и rootless Docker не являются поддерживаемым вариантом. Общая инструкция
  Linux VPS не означает поддержку любого Linux.
- Root или пользователь с sudo, постоянный публичный IPv4. IPv6-only VPS не подходит.
- Python 3.11+, OpenSSL 3, доверенные CA, Docker Engine для Linux и Compose plugin
  версии 2 или новее. Старый отдельный `docker-compose` не используется.
- Preflight требует минимум **1 ГиБ свободного диска**; это порог проверки, а не
  достаточный размер VPS. Нужен запас под Docker images, данные, историю и копии.
  Backup резервирует минимум 512 МиБ либо примерно 2,4 размера данных + 16 МиБ,
  смотря что больше. Проверенного минимального числа CPU/RAM/участников нет;
  не считайте небольшой VPS подтверждённой нагрузочной конфигурацией.
- Исходящий HTTPS к GitHub API/downloads, GHCR и репозиториям ОС/Docker.
  Нужны корректные часы VPS для проверки срока подписанных манифестов.

Ниже команды для **Bash** обычного пользователя с sudo. Если вошли как **root**,
выполняйте те же команды без префикса `sudo`; команды `git`, `cd`, `read` и проверку
checkout всё равно выполняйте в одном shell. Не нужен вход в группу `docker`.
Для root начальная установка зависимостей выглядит так:

```bash
apt-get update
apt-get install -y python3 openssl ca-certificates git curl iproute2
```

Для пользователя с sudo:

Оба поддерживаемых дистрибутива используют apt; названия пакетов ниже одинаковы.

```bash
sudo apt-get update
sudo apt-get install -y python3 openssl ca-certificates git curl iproute2
cat /etc/os-release
dpkg --print-architecture
python3 --version
openssl version
df -h / /var
timedatectl status
```

Не запускайте блоки повторно после ошибки: сначала устраните её. Сохраните доступ
по SSH и консоль восстановления провайдера.

## 2. Сеть и свободные порты

Откройте во входящем firewall VPS **и панели провайдера**:

| Назначение | Порт по умолчанию | Доступ |
| --- | --- | --- |
| HTTPS/API/сигнализация | TCP 18443 (`PORT`) | Участникам |
| Медиа TCP | TCP 18444 (`PORT+1`) | Участникам |
| Медиа UDP | UDP 18445 (`PORT+2`) | Участникам |
| Служебный listener | TCP 18446 (`PORT+3`) | Только loopback; наружу не открывать |

Manager не меняет firewall, настройки SSH или правила провайдера. Compose использует
`network_mode: host`: это listeners хоста, а не публикация портов через `ports:`.
Проверьте правила используемого firewall, не отключая его целиком.

```bash
sudo ss -lntup
```

До установки выбранная группа из четырёх портов должна быть свободна. Базовый порт
можно выбрать в диапазоне 1024–65532. При конфликте остановитесь: определите владельца
listener либо выберите другую свободную группу, не останавливая чужие службы.
**Linux Manager не поддерживает смену IP/базового порта уже установленного сервера.**
Заранее выберите постоянный адрес; не обходите ограничение правкой Compose/state.

## 3. Получить доверенный checkout

Bootstrap — исполняемый код с правами root. Получите полный SHA проверенного
коммита официального репозитория у владельца/из доверенного процесса проверки.
Сверьте его до запуска; SHA, взятый только из того же непроверенного архива, не
является независимым подтверждением. Git checkout не проверяет подпись Git-тега
автоматически. Не используйте `curl | sh` и ключи из случайного Manager bundle.

```bash
git clone --no-checkout https://github.com/IlyaRusskikh/PawTalk.git pawtalk-bootstrap
cd pawtalk-bootstrap
read -r -p 'Полный SHA доверенного коммита (40 hex): ' PAWTALK_BOOTSTRAP_SHA
[[ "$PAWTALK_BOOTSTRAP_SHA" =~ ^[0-9a-f]{40}$ ]] &&
git checkout --detach "$PAWTALK_BOOTSTRAP_SHA" &&
test "$(git rev-parse HEAD)" = "$PAWTALK_BOOTSTRAP_SHA"
git status --short
git log -1 --format='%H %s'
sha256sum manager/trust.json
python3 -B -I manager/pawtalkctl --self-test
```

Ожидается чистый checkout и `PawTalk manager protocol 1 OK`. Протокол launcher 1
не означает Server API 1. Сверьте `manager/trust.json` с доверенным исходником:
отдельные разделы `server` и `manager` содержат публичные Ed25519 trust roots.
Контрольная сумма файла сама по себе не доказывает происхождение ключей.
В checkout должны быть совместимые API 2 bootstrap и корни доверия.

## 4. Docker и установка через Linux Manager

Если Docker уже установлен, **до bootstrap** проверьте:

```bash
sudo systemctl enable --now docker
sudo docker info --format '{{.OSType}}'
sudo docker compose version --short
```

Нужны `linux` и Compose major ≥ 2. Если Docker отсутствует, пропустите эти три
команды: флаг ниже разрешает встроенный bootstrap Docker из его официального apt
репозитория. Он устанавливает `docker-ce`, `docker-ce-cli`, `containerd.io`,
`docker-buildx-plugin`, `docker-compose-plugin` и включает службу Docker.
Существующую apt-конфигурацию Docker он не перезаписывает, конфликтующие пакеты
автоматически не удаляет. При конфликте сверяйтесь с
[официальной установкой Docker для Debian](https://docs.docker.com/engine/install/debian/)
или [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
и оцените существующие нагрузки; не выполняйте массовую очистку Docker.

Из проверенного checkout в интерактивном SSH-терминале:

```bash
sudo python3 -B -I manager/pawtalkctl --lang ru install --bootstrap-docker
```

Мастер спросит внешний IPv4, базовый порт, лимит истории в МиБ (по умолчанию 128;
0 — без лимита) и автообновления. Кандидат IPv4 из внешних сервисов нужно сверить
с панелью VPS. Ответ на автообновления применяется сразу к Server и Manager;
по умолчанию в мастере «да». Для контролируемого первого запуска можно ответить
«нет» и включить позже. E2EE обязательно: поля пароля и key ID отсутствуют, секрет
создаст клиент первого администратора. Ничего секретного на VPS вводить не нужно.

Bootstrap обнаруживает релизы Server/Manager независимо, включая prerelease,
проверяет Ed25519-подпись, тип/версию/канал, срок и API/data schema 2 манифестов.
Manager bundle проходит проверку размера, SHA-256, состава и self-test; затем
управление передаётся **установщику из проверенного bundle**. Server загружается
из GHCR по подписанному immutable digest, не по изменяемому тегу. Manager создаёт
свой Compose project и постоянный volume, запускает контейнер, проверяет health
и идентичность. Не запускайте `docker compose up` из checkout вручную.

После успеха используется установленный launcher:

```bash
sudo docker info --format '{{.OSType}}'
sudo docker compose version --short
sudo systemctl is-enabled docker
sudo pawtalkctl --lang ru status
sudo pawtalkctl doctor
```

`status`/`doctor` выводят JSON. Оценивайте поля, а не только exit code: нужны
`installed: true`, `running: true`, `identityOK: true`, здоровое состояние
(`Работает` при русском языке) и ожидаемые версии. `externalNetworkVerified: false`
означает, что проверка из интернета не выполнялась, и не является ошибкой установки.
При прерывании установки сначала выполните doctor через checkout, если launcher
ещё отсутствует: `sudo python3 -B -I manager/pawtalkctl doctor`.
Повторный `install` сохраняет имеющиеся данные/настройки/digest и пытается запустить
существующую установку; он не делает чистый сброс или автоматическую миграцию API 1.

### Удалить bootstrap-клон после установки (необязательно)

Когда установленная команда `sudo pawtalkctl doctor` показывает `installed: true`,
`running: true`, `identityOK: true` и `transactionPending: false`, каталог
`pawtalk-bootstrap` больше не нужен для обычной работы, обновлений или backup.
Manager уже установлен отдельно и не запускает код из исходного checkout.

Если вы всё ещё находитесь внутри клона `pawtalk-bootstrap`, созданного на шаге 3,
проверьте текущий путь и удалите только этот клон:

```bash
pwd
test "$(basename "$PWD")" = pawtalk-bootstrap &&
cd .. &&
rm -r -- pawtalk-bootstrap
```

Не удаляйте `/opt/pawtalk`, `/opt/pawtalk-manager`, `/etc/pawtalk`,
`/var/lib/pawtalk-manager`, Docker volume сервера или backup-директории:
это части установленного сервера и его данные. Удаление клона их не затрагивает.
Если установка не завершилась и launcher ещё недоступен, сначала сохраните клон
для диагностики/повторного запуска. Для восстановления на чистом VPS доверенный
checkout при необходимости получают заново.

## 5. Первое вступление администратора

После установки терминал показывает одноразовую ссылку первого администратора.
Пока сервер не инициализирован, получить ссылку можно также так:

```bash
sudo pawtalkctl initial-admin --url
printf '\n'
```

Команда не добавляет перевод строки; `printf` лишь завершает строку терминала.
Передайте **полную** ссылку приватно на свой компьютер и вставьте в совместимый
Windows Client → «Присоединиться к серверу». Это `pawtalk://…`, а не веб-страница.
Отпечаток сертификата и фрагмент после `#` не менять. Ссылка действует 24 часа и
расходуется при первом вступлении; первый клиент создаёт root E2EE и сохраняет его
в защищённом хранилище ОС. После инициализации Manager больше не выдаёт начальную
административную ссылку (CLI возвращает код 2). Обычные ссылки создаются в Client
администратором/модератором; дополнительных администраторов назначает администратор.

Вступление не подключает голос автоматически. Проверьте текстовый чат, затем
голосовой канал с участником из другой сети. Здоровый контейнер не доказывает
внешнюю TCP/UDP-доступность. Если управляющий клиент находится в той же LAN, что
сервер, см. [локальный/внешний адрес приглашений](SERVER-API2.md#локальный-и-внешний-адрес-постоянного-сервера).
Не размещайте приглашения, terminal output или данные диагностики с адресами в Issues.

## 6. Контейнер, systemd и перезагрузка

```bash
sudo pawtalkctl logs
sudo docker ps --filter label=io.pawtalk.managed=compose-v1
sudo systemctl status docker --no-pager
sudo systemctl status pawtalk-health.timer --no-pager
sudo systemctl list-timers --all 'pawtalk-*'
sudo journalctl -u pawtalk-health.service -u pawtalk-update.service -n 100 --no-pager
```

Healthcheck выполняется каждые 10 секунд с начальным grace 30 секунд и проверяет
API/LiveKit/локальный HTTPS. `pawtalk-health.timer` запускается через 3 минуты после
boot, затем каждые 2 минуты с jitter до 30 секунд. Он восстанавливает незавершённые
транзакции и ограниченно перезапускает работающий `unhealthy` контейнер: максимум
три попытки с backoff. Остановленный контейнер watchdog сам не запускает.

Server — контейнер с `restart: unless-stopped`, отдельной `pawtalk-server.service`
на Linux нет. `pawtalk-*.service` — oneshot; состояние `inactive (dead)` между
срабатываниями нормально, проверяйте timers и результаты запусков. Update timer
может быть выключен, если обе настройки автообновлений выключены.

После первого успешного подключения и в согласованное окно обслуживания:

```bash
sudo systemctl reboot
```

SSH отключится, звонки прервутся. После восстановления SSH выполните:

```bash
sudo systemctl is-active docker
sudo pawtalkctl status
sudo systemctl list-timers --all 'pawtalk-*'
sudo pawtalkctl logs
```

Снова подключитесь Client и проверьте членство, историю и голос. Docker должен
стартовать при загрузке и возобновить контейнер. Если его ранее явно остановили
или выполнили uninstall, `unless-stopped` не означает автоматическое возобновление.
Для сохранённой установки штатный повторный `sudo pawtalkctl install` запускает её
с прежними данными. Настоящий reboot и внешнюю сеть нельзя подтвердить обычным
Linux userspace-контейнером.

## 7. Обновления и настройки

Проверка доступных версий не меняет установку:

```bash
sudo pawtalkctl update check
sudo pawtalkctl manager check
```

Ручное обновление: сначала создайте копию (следующий раздел), прочитайте release
notes и выберите окно обслуживания. Для обычных совместимых API 2 обновлений:

```bash
sudo pawtalkctl manager now
sudo pawtalkctl update now
sudo pawtalkctl doctor
```

Порядок выше обновляет средство управления перед Server, но не заменяет требования
совместимости конкретного будущего выпуска. Manager не мигрирует API 1. Server update
делает verify/pre-pull, lock/journal, остановку, согласованный backup, замену через
Compose и проверку health/identity. При неудаче восстанавливаются **образ и данные**.
Звонки прерываются; обновление одного Manager без изменения runtime не требует
перезапуска Server. Не заменяйте image руками и не редактируйте управляемый Compose.

Включить обе линии автообновлений либо выключить их:

```bash
sudo pawtalkctl configure PAWTALK_SERVER_AUTO_UPDATE=true PAWTALK_MANAGER_AUTO_UPDATE=true --yes
sudo systemctl list-timers --all 'pawtalk-*'
```

Для выключения повторите `configure` со значениями `false`. Update timer: через
5 минут после boot, затем каждые 30 минут, задержка до 3 минут. Linux periodic сначала
обрабатывает Manager; после его активации Server может обновиться на следующем
срабатывании. Ошибка Manager discovery также может прервать текущий periodic до
проверки Server; обе линии можно проверить вручную. Здоровый Server не останавливается
из-за одной ошибки загрузки обновления. Выбирается последняя опубликованная SemVer
своего семейства **включая prerelease**; переключателя stable-only в Linux CLI нет.

Другие поддерживаемые настройки меняются через Manager, например:

```bash
sudo pawtalkctl configure PAWTALK_CHAT_MAX_MB=256 PAWTALK_BACKUP_KEEP=5 --yes
```

Уменьшение истории может вытеснить старые сообщения. Изменение runtime-настроек
использует backup/перезапуск/проверку; IP и порт на Linux после установки изменить
этой командой нельзя. `--yes` — явное согласие на операцию; без него CLI просит
подтверждение в TTY. Не выполняйте configure параллельно с backup/update.

## 8. Backup и восстановление

```bash
sudo pawtalkctl backup create
sudo pawtalkctl backup list
```

`create` кратковременно останавливает Server, копирует согласованные данные и
возобновляет ранее работающий контейнер. Сохраните выведенное имя `backup-…`.
Копия содержит `data.tar`, metadata/checksum, подписанный Server receipt и, при
наличии, проверенный Manager bundle/manifest. По умолчанию хранятся пять копий:
старые собственные завершённые копии удаляются после успешных операций.
Проверяйте свободное место и храните **всю директорию копии** за пределами VPS
по защищённому каналу; это не делает CLI автоматически.

Для восстановления существующего сервера (звонки будут прерваны):

```bash
read -r -p 'Имя копии из backup list: ' PAWTALK_BACKUP_NAME
sudo pawtalkctl backup restore "$PAWTALK_BACKUP_NAME"
sudo pawtalkctl doctor
```

Подтвердите восстановление в TTY; для намеренной автоматизации предусмотрен
`--yes`. CLI проверяет архив, подписи, схемы и принадлежность до прерывания сервера,
создаёт новый restore volume и сохраняет исходный volume. При восстановлении в
существующую установку версия установленного Manager сохраняется.

Для восстановления на **чистом** поддерживаемом VPS нужны зависимости, работающие
Docker/Compose и доверенный checkout из шагов выше. Скопируйте полную backup-директорию
в `/var/backups/pawtalk/` с владельцем root и приватными правами (каталоги 0700,
файлы 0600). До restore **не выполняйте новую установку Server**. Из checkout:

```bash
read -r -p 'Имя перенесённой копии backup-…: ' PAWTALK_BACKUP_NAME
sudo python3 -B -I manager/pawtalkctl backup restore "$PAWTALK_BACKUP_NAME" --trust manager/trust.json
sudo pawtalkctl doctor
```

Восстанавливается подписанный Manager из копии; Server image должен быть доступен
по сохранённому GHCR digest. Историческое восстановление допускает возраст
сохранённого манифеста, сохраняя проверку подписи. Требуется прежний IP/порт:
произвольный перенос Linux-установки на другой адрес не поддерживается. Нет
автоматической миграции API 1 backup в API 2. Серверный backup **не содержит
клиентский root E2EE**: без сохранившихся клиентских ключей он не восстановит
расшифровку. Проверяйте restore на отдельном тестовом окружении.

## 9. Где хранятся данные

| Путь | Назначение |
| --- | --- |
| `/etc/pawtalk/config.env` | Root 0600, данные конфигурации; не shell-скрипт, не выполнять `source` |
| `/etc/pawtalk/trust.json` | Установленные публичные корни доверия |
| `/var/lib/pawtalk-manager/installed.json` | Версии, immutable image digest, project/volume и проверяемая идентичность |
| `/var/lib/pawtalk-manager/transaction.json` | Незавершённая транзакция; вручную не удалять |
| `/var/lib/pawtalk-manager/last-operation.json`, `last-error.json`, `health.json` | Результаты операций и watchdog |
| `/opt/pawtalk/compose.server.yaml` | Управляемый production Compose template |
| `/opt/pawtalk-manager/versions/`, `current`, `previous` | Проверенные Manager версии и атомарные указатели |
| `/opt/pawtalk-manager/launcher`, `/usr/local/bin/pawtalkctl` | Стабильный launcher и команда CLI |
| `/var/backups/pawtalk/backup-…/` | Согласованные приватные backup-директории |
| Docker volume из поля `volume` | `/data` контейнера: TLS/state и `membership-v2.sqlite` с постоянными данными API 2 |

Не редактируйте state, Compose, файлы установленных версий и ключи вместо
штатных команд. Удаление/замена trust root или стабильного launcher требует
отдельного обслуживания; обычный Manager update это отвергает. Добавление новых
ключей возможно через bundle, подписанный уже доверенным ключом.

## 10. Ошибки и безопасное удаление

| Симптом | Что проверить |
| --- | --- |
| Занят порт | До install: `sudo ss -lntup`, все четыре порта; не останавливать чужие процессы |
| Docker/Compose недоступны | `sudo docker info`, `sudo docker compose version`, `sudo systemctl status docker --no-pager`; Docker должен быть Linux, Compose major ≥ 2 |
| GitHub/GHCR недоступны | DNS, исходящий HTTPS, CA, часы, сетевые ограничения/rate limit; `sudo pawtalkctl doctor`, `sudo pawtalkctl logs`, journalctl timers. Не отключать подписи/TLS и не подменять image непроверенным зеркалом |
| Манифест не принимается | Версия bootstrap/trust roots, срок манифеста, API/data schema, совместимость опубликованного релиза; не сбрасывать установленное состояние |
| Контейнер healthy, Client не входит | Реальный публичный IPv4, TCP `PORT`, firewall провайдера/ОС; не открывать `PORT+3` |
| Чат работает, голоса нет | UDP `PORT+2`, TCP `PORT+1`, правила провайдера, маршрут/VPN и клиент в другой сети; HTTP healthcheck не проверяет внешний UDP |
| Another operation is running | Дождаться update/backup; не удалять lock/journal и не запускать конкурирующие операции |
| unhealthy/backoff/transactionPending | doctor, logs и журнал oneshot services; watchdog/следующая изменяющая команда выполняет recovery. `status`/`doctor` сами recovery не запускают |

Логи CLI редактируют приглашения, но перед передачей отчёта всё равно проверьте его
на персональные адреса и секреты. Автоматической диагностики внешнего UDP в Manager нет.

Чтобы остановить установку с сохранением данных, сначала сделайте и вывезите backup:

```bash
sudo pawtalkctl uninstall --keep-data
```

Подтверждение обязательно (или явный `--yes`). Удаляются только контейнеры собственного
Compose project, отключаются `pawtalk-update.timer` и `pawtalk-health.timer`.
Данные, конфигурация, backup и инструменты остаются; это **не полное стирание**.
Чужие ресурсы не затрагиваются. Команды purge нет; не применяйте `docker system prune`,
удаление всех volumes или массовое удаление каталогов. Повторный `pawtalkctl install`
возобновляет сохранённую установку. Для окончательного уничтожения данных нужна
отдельная проверка точного project/volume и сохранённых копий владельцем.

## English overview

This is the primary fresh Linux VPS guide for published API 2 releases.
The current Manager supports Debian 12 and Ubuntu 24.04 LTS on amd64/arm64.
Both use the apt commands below; Docker bootstrap selects the distribution's
official repository. Other distributions/versions are unsupported. systemd,
root/sudo, a persistent public IPv4, Python 3.11+,
OpenSSL 3 and Linux Docker Engine with Compose plugin major ≥ 2 are covered.
The 1 GiB free-space preflight threshold is not a capacity recommendation;
CPU/RAM/concurrency acceptance remains unmeasured. Published versions come from
the downloads catalog; the dated release links above are a compatibility snapshot.

Run the numbered Bash blocks in order, using sudo as a regular user or omitting
sudo as root. Review a trusted immutable source SHA and trust roots before running
bootstrap. `install --bootstrap-docker` can install missing Docker from its official
apt repository, verifies published Server/Manager manifests and Manager bundle,
then hands off to verified code and deploys the signed Server digest through Compose.
No password/manual key ID, API 1 migration, signature bypass or direct image replacement.
Keep the full first-admin invitation private, join with a compatible Windows Client,
then test chat and voice from another network. Only TCP PORT/PORT+1 and UDP PORT+2
are public; PORT+3 stays loopback-only.

Use installed pawtalkctl for status/logs/doctor, independent updates, configure,
backup/restore and data-preserving uninstall. Automatic updates include prereleases.
After successful installation and healthy doctor results, the bootstrap repository
clone can be deleted; installed Manager/runtime/configuration/data/backups remain
separate. Keep the clone until incomplete installation is resolved; obtain a trusted
checkout again when needed for fresh-host recovery.
Linux cannot change an installed server's IP/base port. Backup interrupts calls and
must be copied off-host; server copies do not include client E2EE roots. Restore to
a fresh host requires the complete backup, trusted checkout/keys, Docker and the
same address/ports with access to the saved image digest. Docker restart policy and
systemd timers support reboot recovery; verify a real reboot yourself. Container
userspace tests do not prove native boot/systemd, external UDP or physical devices.
