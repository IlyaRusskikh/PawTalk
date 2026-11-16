# Первый администратор и проверка перезагрузки Linux

[English](first-server.en.md) · [Установка Linux](installation.ru.md)

После успешной установки создайте **одну ссылку первого администратора**:

~~~bash
sudo pawtalkctl initial-admin --url
printf '\n'
~~~

Передайте полную ссылку `pawtalk://` приватно на совместимый Windows Client и выберите **Присоединиться к серверу**. Это не URL веб-сайта. Сохраните отпечаток сертификата и секретный фрагмент. Ссылка действует 24 часа и расходуется один раз; Client создаёт E2EE root в защищённом хранилище ОС. После инициализации host CLI не может создать ещё одну bootstrap-ссылку.

Вступление **не подключает к голосу автоматически**. Проверьте текстовый чат, а затем звонок с другого реального устройства/сети. Здоровый контейнер не гарантирует доступность внешнего UDP.

## Проверка жизненного цикла

~~~bash
sudo pawtalkctl status
sudo pawtalkctl doctor
sudo pawtalkctl logs
sudo docker ps --filter label=io.pawtalk.managed=compose-v1
sudo systemctl list-timers --all 'pawtalk-*'
~~~

Server работает через Docker Compose с `restart: unless-stopped`; отдельной службы `pawtalk-server.service` **нет**. Health/update units Manager запускаются системными таймерами как oneshot; состояние `inactive (dead)` между запусками может быть нормальным.

После первой успешной проверки запланируйте настоящую перезагрузку хоста в окно обслуживания, затем повторите проверки статуса/таймеров и вход из Client. Состояние и история должны пережить reboot; watchdog сам не запускает намеренно остановленный контейнер.

[Управление](management.ru.md) · [Сеть](../../server/networking.ru.md).
