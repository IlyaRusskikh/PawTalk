# Установка постоянного PawTalk Server на Linux

[English](installation.en.md) · [О Manager](../overview.ru.md)

Это инструкция новой установки **опубликованного API 2** через **Linux Manager**. Поддерживаемые платформы: **Debian 12 Bookworm или Ubuntu 24.04 LTS, amd64/arm64, systemd**. Debian 13, другие дистрибутивы, rootless Docker, хосты только с IPv6 и armhf не поддерживаются текущим опубликованным Manager.

Требования: постоянный публичный IPv4, root/sudo, Python 3.11+, OpenSSL 3, доверенные CA, исходящий HTTPS к GitHub/GHCR, правильные часы, Docker Engine для Linux и Compose plugin **v2+**. Preflight требует 1 ГиБ свободного места, но это не рекомендация по ёмкости: нужен запас для образов, истории и backup. Сохраните SSH/консоль восстановления провайдера.

## 1. Подготовка хоста

Команды рассчитаны на Bash пользователя с sudo (для root уберите sudo).

~~~bash
sudo apt-get update
sudo apt-get install -y python3 openssl ca-certificates git curl iproute2
cat /etc/os-release
dpkg --print-architecture
python3 --version
openssl version
df -h / /var
sudo ss -lntup
~~~

Откройте TCP `PORT`, TCP `PORT+1` и UDP `PORT+2` в брандмауэре или у провайдера (обычно 18443, 18444, 18445). Оставьте внутренний TCP `PORT+3` закрытым (обычно 18446). Последствия смены адреса и базового порта описаны в [руководстве по управлению](management.ru.md).

## 2. Получение доверенного bootstrap

Bootstrap выполняется с правами root; не используйте `curl | sh` или непроверенный коммит. Получите **полный 40-значный SHA** проверенного исходного состояния с актуальными корнями доверия Manager:

~~~bash
git clone --no-checkout https://github.com/IlyaRusskikh/PawTalk.git pawtalk-bootstrap
cd pawtalk-bootstrap
read -r -p 'Полный SHA проверенного коммита: ' PAWTALK_BOOTSTRAP_SHA
[[ "$PAWTALK_BOOTSTRAP_SHA" =~ ^[0-9a-f]{40}$ ]] &&
  git checkout --detach "$PAWTALK_BOOTSTRAP_SHA" &&
  test "$(git rev-parse HEAD)" = "$PAWTALK_BOOTSTRAP_SHA"
sha256sum apps/manager/linux/trust.json
python3 -B -I apps/manager/linux/pawtalkctl --self-test
~~~

Сверьте checkout и `apps/manager/linux/trust.json` с доверенным источником, не подставляйте случайные публичные ключи. При ошибке остановитесь.

## 3. Установка Manager и Server

Из проверенного checkout откройте терминальное меню командой
`sudo python3 -B -I apps/manager/linux/pawtalkctl tui`. Пункт **Обзор → Установить первый
сервер** откроет мастер. В нём можно выбрать опубликованный релиз или указать
его подписанный манифест на диске.

Если Docker уже стоит, проверьте `sudo docker info --format '{{.OSType}}'` и `sudo docker compose version --short` (Linux, Compose major 2+). Если Docker отсутствует, штатный установщик может поставить его из **официального** apt-репозитория:

~~~bash
sudo python3 -B -I apps/manager/linux/pawtalkctl --lang ru install --bootstrap-docker
sudo pawtalkctl --lang ru status
sudo pawtalkctl doctor
~~~

Мастер запросит публичный IPv4, порт, лимит истории и обновления, проверит подписанные выпуски Manager/Server, создаст управляемые Compose/volume и проверит health. **Не запускайте `docker compose up` вручную из bootstrap-клона.** При сбое сохраните файлы транзакции для восстановления.

Далее — [первый администратор](first-server.ru.md). Удалить bootstrap-клон можно только после успешного `sudo pawtalkctl doctor` с подтверждённой установкой Manager; не трогайте `/etc/pawtalk`, `/var/lib/pawtalk-manager` и Docker volumes.
