# Управление Linux Manager

[English](management.en.md) · [Первый сервер](first-server.ru.md)

Установленная команда `pawtalkctl` — поддерживаемый способ управления Linux Manager. Хостовые команды выполняйте с sudo; не правьте сгенерированный Compose, Docker volumes и состояние Manager вручную.

~~~bash
sudo pawtalkctl status
sudo pawtalkctl doctor
sudo pawtalkctl logs
sudo pawtalkctl update check
sudo pawtalkctl manager check
~~~

`status` показывает состояние, `doctor` диагностирует установку, `logs` выводит журналы. `update check` и `manager check` независимо обнаруживают опубликованные релизы **без установки**. Healthcheck контейнера не доказывает работу голоса/UDP извне.

Поддерживаемые runtime-параметры меняются через контроллер с резервным копированием, остановкой и проверкой:

~~~bash
sudo pawtalkctl configure PAWTALK_CHAT_MAX_MB=256 PAWTALK_BACKUP_KEEP=5 --yes
~~~

Уменьшение лимита истории может удалить старые сообщения. `--yes` явно подтверждает изменение. Не запускайте `configure` одновременно с обновлением или backup. Установленный Linux Server **не умеет менять IP или базовый порт** через Manager; не обходите ограничение правкой Compose/state.

Для диагностики служб:

~~~bash
sudo systemctl status docker --no-pager
sudo systemctl list-timers --all 'pawtalk-*'
sudo journalctl -u pawtalk-health.service -u pawtalk-update.service -n 100 --no-pager
~~~

Таймер здоровья ограниченно восстанавливает нездоровый работающий контейнер, но не запускает контейнер, остановленный администратором намеренно.

[Backup, обновления и удаление](maintenance.ru.md).
