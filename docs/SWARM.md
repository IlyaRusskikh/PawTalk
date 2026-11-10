# Docker Swarm: обслуживание и обновления VPS

Docker Swarm — единственный поддерживаемый способ развёртывания постоянного
сервера на VPS. Новая установка с готовым образом без исходников:
[SERVER.md](SERVER.md). Здесь описаны миграция существующей комнаты, ручные
обновления, откат и необязательный таймер. Обычный Compose для VPS больше
не поддерживается; старую установку можно остановить обычным `docker stop`
после проверки её имени и volume.

Реальный rollout/rollback на Linux Swarm и приёмка на VPS ещё не выполнялись.
Перед миграцией и обновлениями сохраняйте резервную копию всего volume.

## Как обновляется комната

`compose.server.swarm.yaml` запускает одну комнату как сервис `pawtalk_server`
стека `pawtalk`. TLS, пароль и SQLite находятся во внешнем Docker volume из
`PAWTALK_DATA_VOLUME`. Сервис закреплён за узлом с меткой `pawtalk.data=true`;
назначайте её только узлу с данными комнаты. Локальный volume не реплицируется.
Команды управления выполняются на manager-узле, операции с volume и `docker exec`
— на узле с данными. В одноузловой установке это один VPS.

Обновление использует `stop-first`, healthcheck и автоматический rollback.
У комнаты фиксированные TCP/UDP-порты и локальная SQLite: оставляйте `replicas: 1`.
Звонок прерывается; участникам может потребоваться переподключиться.
См. [host networking](https://docs.docker.com/engine/network/drivers/host/)
и [настройки update/rollback](https://docs.docker.com/reference/compose-file/deploy/).

`PAWTALK_CHAT_MAX_MB=128` задаёт бюджет SQLite-базы чата в МиБ, `0` отключает
лимит. Учитываются сообщения, изображения, профили и индексы; удаляется старейшая
история. Изменения `.env` применяются через `deploy`, а не простым перезапуском.

## Переход с Compose

Команды выполняются на VPS под root. Нужны Docker Engine, Python 3.9+ и файлы
из [шага 3 установки](SERVER.md#3-скачайте-файлы-развёртывания-и-заполните-env).

1. Найдите контейнер старой комнаты и проверьте его подключение `/data` через
   `docker inspect`. Запишите точное имя volume: обычно это
   `pawtalk-server_server_data`. Сохраните прежний `.env` отдельно.
2. Найдите **точное имя работающего старого контейнера**, прежде чем
   останавливать его (это может быть контейнер из прежнего Docker Compose).
   Остановка выполняется обычным Docker CLI — Compose plugin не нужен:

   ```sh
   docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Mounts}}'
   docker inspect <OLD_CONTAINER_NAME> --format '{{json .Mounts}}'
   docker stop <OLD_CONTAINER_NAME>
   docker ps -a --filter name=<OLD_CONTAINER_NAME>
   ```

   Вместо `<OLD_CONTAINER_NAME>` подставьте имя **именно вашего PawTalk-контейнера**
   из первой команды. Перед остановкой сверяйте образ и подключение `/data`;
   если контейнер не найден или имя неоднозначно, остановитесь и проверьте
   конфигурацию вручную. Эти команды **не удаляют контейнер или volume**.
   Дождитесь остановки и сохраните резервную копию **всего volume**, включая
   SQLite, TLS и состояние комнаты.
3. Включите Swarm и назначьте узлу с данными метку, как в
   [шаге 2 установки](SERVER.md#2-установите-docker-engine-и-включите-swarm).
   Не запускайте `swarm init`, если узел уже состоит в Swarm. Для одного VPS
   управляющие порты Swarm в интернет не открываются.
4. Подготовьте `.env` по `.env.server.swarm.example`: перенесите прежние IP, порт,
   настройки E2EE, лимит истории и прокси обновлений. В `PAWTALK_DATA_VOLUME`
   укажите **точное имя прежнего volume**. Не создавайте пустой volume взамен.
   Укажите согласованные `PAWTALK_IMAGE` и `PAWTALK_RELEASE`, оставьте
   `PAWTALK_AUTO_UPDATE=false`. Сначала мигрируйте на той же версии образа;
   обновление версии выполняйте отдельно после проверки комнаты.
5. Разверните стек:

   ```sh
   python3 scripts/server-update.py deploy --config .env --stack pawtalk
   docker stack services pawtalk
   docker service ps pawtalk_server --no-trunc
   docker service logs --tail 30 pawtalk_server
   ```

Дождитесь `1/1`, задачи `Running` и статуса контейнера `healthy` по
[шагу 6 установки](SERVER.md#6-разверните-стек). Проверьте прежнее приглашение,
пароль, историю и голос двух клиентов из разных сетей. Не запускайте одновременно
старый контейнер и сервис Swarm с одним volume. Не снимайте привязку к узлу
и не увеличивайте число реплик.

## Ручное обновление и откат

Все команды ниже выполняются из `/opt/pawtalk`. Сначала сделайте
[резервную копию](SERVER.md#где-данные-и-как-сохранить-комнату).
Прочитайте release notes, проверьте совместимость данных и существование
публичного образа новой версии. Не используйте `latest`.

Для ручного обновления измените в `.env` **обе строки**:
`PAWTALK_IMAGE=ghcr.io/ilyarusskikh/pawtalk-server:X.Y.Z` и
`PAWTALK_RELEASE=X.Y.Z`, подставив опубликованную версию без `v`.
При необходимости скачайте обновлённые стек и скрипт той же версии по схеме
из `SERVER.md`; сохраните рабочий `.env`. Примените конфигурацию:

```sh
python3 scripts/server-update.py deploy --config .env --stack pawtalk
docker service ps pawtalk_server --no-trunc
docker service inspect --format '{{json .UpdateStatus}}' pawtalk_server
docker service logs --tail 30 pawtalk_server
```

`deploy` возвращает управление до завершения rollout. Дождитесь `1/1`, `healthy`
и, при обновлении существующего сервиса, `UpdateStatus.State=completed`.
`rollback_completed` означает возврат прежней конфигурации, а не успешную установку
новой версии. Проверьте приглашение, историю и голос.

Ручной откат к предыдущей спецификации сервиса:

```sh
python3 scripts/server-update.py rollback --config .env --stack pawtalk
```

Откат возвращает предыдущую спецификацию, включая образ и настройки, но
**не откатывает содержимое volume**. При несовместимых изменениях данных нужна
подходящая резервная копия. На самой первой установке предыдущей спецификации нет.

После отката или автоматического обновления проверьте фактические образ и версию:

```sh
docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' pawtalk_server
docker service inspect --format '{{index .Spec.Labels "io.pawtalk.version"}}' pawtalk_server
```

Перенесите эти значения в `PAWTALK_IMAGE` и `PAWTALK_RELEASE` файла `.env`
перед следующим `deploy`. Скрипт обновляет сервис, но не переписывает `.env`;
старые значения при повторном развёртывании вернут старую версию.

## Автообновление — только по флагу

В `.env` по умолчанию:

```dotenv
PAWTALK_AUTO_UPDATE=false
PAWTALK_UPDATE_CHANNEL=preview
PAWTALK_UPDATE_REPOSITORY=IlyaRusskikh/pawtalk
```

`false` отключает сетевую проверку и обновление таймером. `stable` учитывает только
обычные релизы, `preview` — также предварительные выпуски. Скрипт выбирает более
новую X.Y.Z-версию, сравнивает digest из GitHub Release с GHCR, загружает образ
по digest и дожидается rollout. `.env` и скачанные shell-скрипты не выполняются.
Обновлятор работает на хосте; Docker socket не монтируется в контейнер.

Ручная проверка без установки работает независимо от переключателя:

```sh
python3 scripts/server-update.py check --config .env --stack pawtalk
```

Чтобы проверить или установить **определённый опубликованный релиз**, а не
автоматически выбранный последний, укажите `--target-version X.Y.Z` (без `v`).
При этом сохраняются проверка GHCR digest, запрет даунгрейда и правило
`PAWTALK_AUTO_UPDATE=true` для действия `update`; команда `check` ничего
не устанавливает и не требует включения автообновлений. Перед фактическим
обновлением всегда сделайте резервную копию тома:

```sh
python3 scripts/server-update.py check --config .env --stack pawtalk --target-version 0.7.1
# Только если текущая версия старше, том сохранён, а PAWTALK_AUTO_UPDATE=true:
python3 scripts/server-update.py update --config .env --stack pawtalk --target-version 0.7.1
```

Команда с закреплённой версией предназначена также для воспроизводимых CI-тестов
при появлении более новых релизов. Нельзя использовать её для отката к более
старой версии: для отката служит `rollback`, а состояние тома она не меняет.

На VPS с systemd скачайте unit-файлы той же версии, что скрипт (ниже `0.7.1`),
и установите их. Они рассчитаны на `/opt/pawtalk`, `/usr/bin/python3`
и стек `pawtalk`:

```sh
cd /opt/pawtalk
PAWTALK_RELEASE=0.7.1
curl -fL "https://raw.githubusercontent.com/IlyaRusskikh/pawtalk/v${PAWTALK_RELEASE}/deploy/pawtalk-update.service" -o deploy/pawtalk-update.service
curl -fL "https://raw.githubusercontent.com/IlyaRusskikh/pawtalk/v${PAWTALK_RELEASE}/deploy/pawtalk-update.timer" -o deploy/pawtalk-update.timer
install -m 644 deploy/pawtalk-update.service /etc/systemd/system/
install -m 644 deploy/pawtalk-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pawtalk-update.timer
```

Затем явно поставьте в `.env` `PAWTALK_AUTO_UPDATE=true`. Таймер перечитывает
файл при каждом запуске; для этого флага `deploy` не нужен. На системах без systemd
используйте ручные обновления; установка этого таймера к ним не применяется.

Проверка выполняется раз в 30 минут со случайным сдвигом. Одновременные запуски
автоматического `update` блокируются lock-файлом. Ручной `deploy` и rollback
выполняйте после остановки таймера и завершения уже работающего обновлятора.

```sh
systemctl list-timers pawtalk-update.timer
journalctl -u pawtalk-update.service -n 30
```

При неуспешном rollout Swarm возвращает предыдущую спецификацию. Скрипт считает
это ошибкой. Для выключения автообновлений поставьте
`PAWTALK_AUTO_UPDATE=false`; таймер можно также остановить через
`systemctl disable --now pawtalk-update.timer`.

CI проверяет разбор конфигурации Swarm и unit-тесты выключенного режима,
выбора версий/каналов, несовпадения digest и последовательности обновления.
Дополнительно на одноразовом GitHub-hosted Linux-узле тест `scripts/swarm-smoke.mjs`
инициализирует Docker Swarm, запускает опубликованный образ через **настоящий**
`server-update.py deploy`, делает принудительную замену задачи того же образа,
откатывает спецификацию через `server-update.py rollback` и проверяет сохранность
тома, пароля, приглашения и TLS-идентичности. Тест запускается только при
отсутствии существующего Swarm, ресурсы удаляются после проверки.

Дополнительно в CI выполняется **реальное обновление опубликованных образов**
`0.7.0 → 0.7.1` через `scripts/server-update.py update --target-version 0.7.1`.
Скрипт проверяет фактические GitHub Release notes и соответствующий GHCR digest,
выдаёт команду Swarm update, а затем через `rollback` возвращается к `0.7.0`.
Проверяются TLS-отпечаток, пароль, внешний том, SQLite-сообщение и идентичность
чат-ленты **до обновления, после обновления и после отката** на одноузловом
GitHub-hosted Linux (AMD64/ARM64). Прежний тест принудительного rollout без смены
образа тоже остаётся.

**Ограничение:** это проверка именно пары `0.7.0 ↔ 0.7.1` и
не доказательство совместимости будущих версий или всех сценариев миграции.
Нельзя подменять ею проверку реального VPS с внешним IP, двумя клиентами,
системными настройками, сетевым доступом и UDP по
[ACCEPTANCE.md](ACCEPTANCE.md).
