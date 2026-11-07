# Swarm и обновления VPS

Это новый локально подготовленный вариант развёртывания. Он не применялся к VPS
и не опубликован как новая версия сервера. Для проверки новых возможностей
соберите образ из текущих исходников; опубликованный 0.4.1 остаётся прежним.

`VOICECORD_CHAT_MAX_MB` в `.env` задаёт бюджет SQLite-базы чата в МиБ: `128` по
умолчанию, `0` — без лимита. Учитываются сообщения, изображения, профили и индексы;
удаляется старейшая история с освобождением дискового места. Срока хранения в семь
дней нет. Изменение применяется при следующем `stack deploy`, вместе с конфигурацией
сервиса; временные журналы транзакций не входят в бюджет базы.

## Как обновляется комната

`compose.server.swarm.yaml` запускает одну комнату как сервис Swarm. TLS, пароль
и SQLite остаются в существующем Docker volume. Сервис закреплён за узлом с меткой
`voicecord.data=true`; назначайте её только узлу с данными комнаты.
Обновление использует `stop-first`, healthcheck и автоматический rollback.

У комнаты фиксированные TCP/UDP-порты и локальная SQLite, поэтому две копии
одновременно не запускаются. Обновление кратко прерывает звонок; участникам может
потребоваться переподключиться. Это rolling update с откатом, а не миграция
активного звонка без разрыва. Основание: [host networking](https://docs.docker.com/engine/network/drivers/host/)
и [настройки update/rollback](https://docs.docker.com/reference/compose-file/deploy/).

## Переход с Compose

Команды выполняются владельцем VPS под root. Нужны Docker Engine и Python 3.
Храните исходники и файлы развёртывания в `/opt/voicecord`.

1. Запишите имя существующего volume: `docker volume ls`. Для обычной установки
   это `voicecord-server_server_data`. Не удаляйте volume и не используйте `down -v`.
2. Остановите старый контейнер через его Compose-файл. Пока сервер остановлен,
   сделайте резервную копию volume, включая SQLite, TLS и состояние комнаты.
3. Инициализируйте Swarm, если он ещё не включён:

   ```sh
   docker swarm init --advertise-addr 203.0.113.10
   docker node update --label-add voicecord.data=true "$(docker info --format '{{.Swarm.NodeID}}')"
   ```

   Подставьте IP VPS. Для одного VPS не открывайте управляющие порты Swarm в интернет.
   Пользовательские порты Voicecord остаются прежними.
4. Скопируйте `.env.server.swarm.example` в `.env`. Укажите реальный IP, прежние
   настройки E2EE и **точное имя существующего** volume в `VOICECORD_DATA_VOLUME`.
   Для нового сервера сначала создайте отдельный volume через `docker volume create`.
5. Для проверки этой неопубликованной версии соберите локальный образ:

   ```sh
   docker build -f server/standalone.Dockerfile -t voicecord-server:review .
   ```

   Укажите `VOICECORD_IMAGE=voicecord-server:review`, оставьте
   `VOICECORD_AUTO_UPDATE=false`. Для опубликованных версий используйте точный
   тег `ghcr.io/ilyarusskikh/voicecord-server:X.Y.Z` из соответствующего релиза.
6. Запустите вручную:

   ```sh
   python3 scripts/server-update.py deploy --config .env --stack voicecord
   docker service ps voicecord_server --no-trunc
   docker service logs --tail 30 voicecord_server
   ```

Проверьте прежнее приглашение, два клиента и историю. Для этой схемы не увеличивайте
`replicas` и не снимайте привязку к узлу: другие узлы не имеют этого локального volume.
Чтобы вернуться к Compose, сначала остановите и удалите сервис Swarm, дождитесь
остановки его задачи, затем запустите прежний контейнер с тем же volume.
Не запускайте одновременно два сервера с этим volume.

## Автообновление — только по флагу

В `.env`:

```dotenv
VOICECORD_AUTO_UPDATE=false
VOICECORD_UPDATE_CHANNEL=preview
VOICECORD_UPDATE_REPOSITORY=IlyaRusskikh/voicecord
```

`false` отключает и сетевую проверку, и обновление таймером. `stable` учитывает только
обычные релизы, `preview` — также предварительные выпуски. Скрипт выбирает более новую
X.Y.Z-версию, сравнивает digest из описания GitHub Release с GHCR, загружает образ
по digest и дожидается rollout. Содержимое `.env` и скачанные shell-скрипты не
выполняются. Docker socket в контейнер не монтируется: обновление работает на хосте.

Ручная проверка без установки работает независимо от переключателя:

```sh
python3 scripts/server-update.py check --config .env --stack voicecord
```

Чтобы включить расписание, установите unit-файлы, затем явно измените флаг на `true`:

```sh
install -m 644 deploy/voicecord-update.service /etc/systemd/system/
install -m 644 deploy/voicecord-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now voicecord-update.timer
```

Проверка запускается раз в 30 минут со случайным сдвигом. Одновременные обновления
блокируются lock-файлом. Пути в service рассчитаны на `/opt/voicecord`.

```sh
systemctl list-timers voicecord-update.timer
journalctl -u voicecord-update.service -n 30
python3 scripts/server-update.py rollback --config .env --stack voicecord
```

При неуспешном rollout Swarm возвращает PreviousSpec. Скрипт считает такой запуск
ошибкой и не сообщает об успешном обновлении. Чтобы выключить автообновление,
поставьте `VOICECORD_AUTO_UPDATE=false`; таймер можно также остановить через
`systemctl disable --now voicecord-update.timer`.

Локально проверены разбор stack-конфигурации Docker CLI и unit-тесты выключенного
режима, выбора версий/каналов, несовпадения digest и последовательности обновления.
Реальный rollout/rollback на Linux Swarm и приёмка на VPS ещё не выполнялись.
