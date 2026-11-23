# Обслуживание Linux Manager

[English](maintenance.en.md) · [Управление](management.ru.md)

## Обновления

Перед обслуживанием прочитайте требования совместимости и сделайте backup. Сначала проверьте выпуски без установки, затем осознанно обновите Manager и Server:

~~~bash
sudo pawtalkctl manager check
sudo pawtalkctl update check
sudo pawtalkctl backup create
sudo pawtalkctl manager now
sudo pawtalkctl update now
sudo pawtalkctl doctor
~~~

Рестарт прерывает звонки. Подписанные пакеты/digest проверяются; при неудаче Server update пытается восстановить **образ и данные**. Не подменяйте образы вручную. Автообновления Linux включаются так:

~~~bash
sudo pawtalkctl configure PAWTALK_SERVER_AUTO_UPDATE=true PAWTALK_MANAGER_AUTO_UPDATE=true --yes
~~~

Для выключения поставьте `false`; периодическая проверка учитывает опубликованные prerelease. Переключателя stable-only в Linux CLI нет.

## Backup и восстановление

~~~bash
sudo pawtalkctl backup create
sudo pawtalkctl backup list
~~~

Backup кратковременно останавливает Server, сохраняет согласованное состояние и запускает ранее работавший контейнер. Переносите **всю приватную директорию копии** за пределы VPS защищённым способом. Для восстановления существующей установки:

~~~bash
read -r -p 'Имя копии из списка: ' PAWTALK_BACKUP_NAME
sudo pawtalkctl backup restore "$PAWTALK_BACKUP_NAME"
sudo pawtalkctl doctor
~~~

На чистом поддерживаемом VPS порядок особый: перенесите полную backup-директорию в `/var/backups/pawtalk/` с приватными правами root, подготовьте доверенный checkout и Docker/Compose, **не устанавливайте новый Server предварительно**, затем из checkout выполните `sudo python3 -B -I apps/manager/linux/pawtalkctl backup restore "$PAWTALK_BACKUP_NAME" --trust apps/manager/linux/trust.json`. Нужны прежний IP/порт и доступный сохранённый GHCR digest. Миграции API 1 нет. Серверный backup не содержит клиентский E2EE root.

В защищённой комнате сохраняйте устройства с более свежими подписанными контрольными точками. Если Client распознает откат политики, он приостановит затронутые отправки. Если осталась только старая копия, её подписи подтверждают состояние на дату копии. Для обнаружения и сверки последующих изменений ролей и отзывов устройств нужны сохранившиеся проверяемые данные новее этой копии.

## Остановка и удаление с сохранением данных

~~~bash
sudo pawtalkctl uninstall --keep-data
~~~

Команда убирает только собственные контейнеры Manager и отключает таймеры; конфигурация, данные и копии сохраняются. Массовой команды purge нет. **Не запускайте `docker system prune` и не удаляйте все volumes** ради удаления PawTalk. Перед окончательным стиранием проверьте идентичность проекта/тома и вывезите копии.

[О Server](../../server/overview.ru.md).
