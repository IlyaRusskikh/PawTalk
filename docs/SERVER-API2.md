# Серверы API 2: запуск и управление

API 2 опубликован. Для чистого постоянного Linux VPS начните с
**[пошаговой установки на Debian](SERVER-DEBIAN.md)**: зависимости, доверенный
bootstrap, Docker/Compose, первое вступление, reboot, обновления и backup/restore.
Это руководство описывает общую модель API 2 и Windows/selfhost. Версии выбирайте
из [GitHub Releases](https://ilyarusskikh.github.io/PawTalk/downloads/),
не по версиям исходных пакетов. Старые опубликованные артефакты не заменяются.
Миграции API 1 нет: нужна чистая конфигурация и новая БД. Старые данные не удаляются
автоматически. Поддерживаемые сочетания перечислены в [COMPATIBILITY.md](COMPATIBILITY.md).

## Временный сервер

В клиенте нажмите «Создать сервер», задайте название. Порт фиксирован: 18443. Клиент проверяет
локальный запуск и при необходимости доступность из интернета. Создатель
автоматически вступает как администратор и создаёт root E2EE в защищённом
хранилище ОС. История находится в памяти до остановки сервера.

Вступление и голос независимы. Текстовый «Общий» и голосовой «Основной» создаются
сразу; удалить их нельзя. Администратор может создавать, переименовывать и удалять
дополнительные каналы. Удаление чата после предупреждения удаляет историю и
изображения; удаление занятого голосового отключает голос, сохраняя членство.

## Чистый постоянный сервер Windows/Linux

Полная последовательность для Debian VPS находится в [основной Linux-инструкции](SERVER-DEBIAN.md).

Manager использует те же Go API и LiveKit, что встроенный хост. В конфигурации
задаются IP, базовый порт, лимит истории и параметры обновлений. По умолчанию:
TCP 18443 (TLS/API/сигнализация), TCP 18444 и UDP 18445 (медиа). Нужны подходящие
правила брандмауэра/маршрутизатора; контейнерные тесты не подтверждают внешний UDP.
E2EE всегда включено. Полей пароля, переключателя E2EE и ручного key ID больше нет.

После первого запуска:

1. В Windows Manager нажмите кнопку начального приглашения администратора либо
   выполните через установленный Manager CLI `pawtalkctl initial-admin --url`.
2. Для прямого управления ядром в Linux-контейнере используйте
   `docker exec <container> /pawtalk serve initial-admin`.
3. Откройте полученную ссылку в клиенте. Первый клиент создаст root, сохранит его
   в OS vault и подтвердит вступление. Начальная ссылка расходуется; срок — 24 часа.
4. После инициализации выдача начальных ссылок недоступна. Другой администратор
   вступает по обычной ссылке и получает роль от существующего администратора.

CLI ядра `serve status` возвращает только API/data versions, server ID и initialized.
`serve info` показывает транспортный адрес с TLS-отпечатком, который сам по себе
не разрешает вступление. Не публикуйте начальную ссылку в логах или Issues.

Linux использует Compose и постоянный том, Windows — службы и приватный каталог.
В нём находятся `state.json` (сертификат и media credentials) и
`membership-v2.sqlite` (схема 2). Клиентский root в резервную копию сервера не входит.
Без устройств с root серверная копия сама по себе не восстанавливает расшифровку.

## Приглашения, роли и выход

### Локальный и внешний адрес постоянного сервера

Для сервера, развёрнутого через Manager, клиент создаёт приглашения с адресом
своего текущего подключения. Внешний IP из настроек Manager не подставляется
автоматически, если в клиенте сохранён локальный IP.

Чтобы новые приглашения содержали внешний IP, выйдите из голосового канала,
откройте меню сервера (три точки или ПКМ) → «Изменить адрес сервера» и замените
только IP в текущем адресе `pawtalk://IP:порт/отпечаток`. Сохраните порт и
TLS-отпечаток сертификата без изменений. При сохранении клиент подключается по
новому адресу и проверяет прежнюю идентичность сервера и членство; это не новое
вступление и не изменение настроек Manager.

Если из локальной сети внешний адрес недоступен, смена может завершиться
`PAWTALK_TLS_TIMEOUT`. Одна из возможных причин — отсутствие NAT loopback
(обращения из LAN к собственному внешнему IP) на роутере. Сам тайм-аут не доказывает
эту причину и не определяет, доступен ли сервер из интернета. При неудачной смене
клиент сохраняет прежний адрес.

В таком случае оставьте локальный адрес в клиенте и создавайте приглашения обычным
способом. Перед отправкой внешнему участнику в скопированной ссылке замените
**только IP** на внешний IP того же сервера. Порт, отпечаток и весь фрагмент после
`#` должны остаться без изменений; это применимо, когда внешний и внутренний порты
совпадают. При перенаправлении на другой внешний порт укажите и соответствующий
внешний порт. Для участников в той же LAN оставьте локальный IP. Повторяйте замену
для каждой новой внешней ссылки: клиент продолжит генерировать локальные.
Уже отправленные ссылки автоматически не изменяются; замена адреса не продлевает
срок приглашения и не создаёт отдельное приглашение.

Проверьте подключение по внешней ссылке из другой сети, а также работу голоса.
Успешное локальное подключение не подтверждает доступность внешних TCP/UDP-портов.
Передавайте полные приглашения только предполагаемым участникам: фрагмент после
`#` содержит данные для вступления и получения ключа E2EE.

Администратор и модератор создают одноразовые ссылки на 24 часа или многоразовые
на час. По 100 активных ссылок каждого типа на сервер. Модератор отзывает свои,
администратор — любые. Сервер хранит encrypted key package; приглашающий может
быть офлайн. Получатель сохраняет ключи до confirm; просроченная резервация требует
нового приглашения для этого устройства. Точные состояния: [API-V2.md](API-V2.md).

Администраторы равноправны. Перед киком/баном другого администратора надо снять
его роль. Последний активный администратор не может выйти или потерять роль,
пока не назначен другой. При выходе/кике/бане сохраняются прежние роли и связи;
возврат требует действующей ссылки. Кик допускает немедленный повторный вход по
такой ссылке, бан — только после снятия/истечения. Истёкший бан сам не возвращает
членство. Наличие ссылки не обходит действующий бан.

Выход удаляет всю связанную группу из списка участников и боковой панели,
сохраняя историю. Повторное вступление основного возвращает связанные устройства.
Чтобы связанное устройство вернулось самостоятельно, ему сначала надо отвязаться.

При отсутствии связи сервер сразу скрывается в клиенте, но запрос выхода хранится
в OS-protected registry. Он переживает перезапуск; клиент периодически пробует
доставить тот же запрос, не возобновляя чтение скрытого сервера. После подтверждения
или ответа, что членство уже прекращено, очередь очищается. TLS/server identity
проверяются как обычно. Отказ LAST_ADMIN возвращает постоянный сервер в список
с объяснением: правило последнего администратора не обходится офлайн.

Исключение для создателя собственного запущенного selfhost: «Выйти с сервера»
предупреждает и останавливает локальный хост вместе со всеми участниками. Другого
администратора назначать не нужно. Право остановки определяется локальным
контроллером и server ID, а не IP, содержимым приглашения или флагом из renderer.

## Устройства

У каждой установки собственная исходная личность. ПКМ по своей строке пользователя
копирует ID: на главной исходный, на сервере — ID объединённого профиля. Связь
создаётся на конкретном сервере через контекстное меню своего профиля; код живёт 10 минут,
оба устройства должны быть онлайн. Связанные устройства получают текущие права
основного и могут редактировать/удалять сообщения группы.

Отвязка возвращает одно устройство в самостоятельный профиль без восстановления
прежних подгрупп. Обычная отвязка не выкидывает с сервера; отзыв потерянного
устройства дополнительно завершает его API-сессии и исключает его. Это не бан.
В голосе допускается одно устройство группы. Передача управления сохраняет ID,
имя, аватар и роль. Если после передачи отвязывается первоначальный владелец ID,
оставшаяся группа получает исходный ID нового основного с сохранением данных группы.

## Обновления и восстановление

Server/Manager/Client имеют независимые подписи и версии. Manager принимает API 2
и схему данных 2; внешняя signing/archive schema и launcher/SCM protocol остаются
версии 1. Изменение настроек/обновление создаёт согласованную копию данных; при
сбое восстанавливаются данные вместе с бинарниками/образом. Обновление одного
Manager без изменения runtime не перезапускает Server.

После смены IP/порта получите новый адрес с TLS-отпечатком. В клиенте ПКМ по серверу
→ «Изменить адрес сервера»; прежний server ID и членство должны подтвердиться.
Для смены адреса сначала выйдите из его голосового канала. Это не новое вступление.

История и вложения зашифрованы, но метаданные видны хосту. Уход/кик/бан не меняют
root и не стирают ранее скачанные данные. Существующие LiveKit grants имеют
оговорённое окно повторного использования. [Модель защиты](E2EE.md).

## English

API 2 is published. For a fresh permanent Linux VPS, start with the
**[Debian installation and operation guide](SERVER-DEBIAN.md)**. This page covers
shared API 2 behavior and Windows/selfhost. Start with fresh configuration
and schema 2; API 1 is rejected, with no migration. E2EE is mandatory and configured
automatically by clients. Selfhost assigns its creator; a clean permanent server
issues a 24-hour single-use first-admin link via Manager/CLI. No host admin link
is available after initialization. Further admins join normally and are promoted.

Membership is independent of voice. Timed invitations deliver opaque encrypted
key packages; clients save keys before confirming. Device links are server-local,
share current rights and message ownership, and permit one voice device per group.
Server backups preserve host/membership identity and encrypted history, but contain
no client root. See [API-V2.md](API-V2.md) and [E2EE.md](E2EE.md).

### LAN and public addresses for a permanent server

For a server deployed through Manager, the client generates invitations using its
current connection address. It does not automatically substitute Manager's public
IP when the client has saved a LAN IP.

To generate public invitations, leave the voice channel, open the server menu
(three dots or right-click) → **Change server address**, and replace only the IP in
the current `pawtalk://IP:port/fingerprint` address. Keep the port and certificate's
TLS fingerprint unchanged. Saving connects to the new address and verifies the
existing server identity and membership; it neither rejoins nor changes Manager's
settings.

If the public address is unreachable from your LAN, saving may fail with
`PAWTALK_TLS_TIMEOUT`. One possible cause is a router without NAT loopback
(accessing its own public IP from the LAN). The timeout alone neither establishes
that cause nor determines internet reachability. A failed change preserves the
client's previous address.

In that case, keep the LAN address in the client and generate invitations normally.
Before sending a copied invitation to an external participant, replace **only the
IP** with the same server's public IP. Preserve the port, fingerprint and entire
fragment after `#`; this assumes the internal and external ports match. If port
forwarding uses a different external port, set that external port as well. Keep
the LAN IP for participants on the same LAN. Repeat the replacement for each new
external invitation: the client will keep generating LAN links. Previously sent
links do not update automatically; changing the address does not extend an
invitation's lifetime or create a separate invitation.

Test the public invitation from another network, including voice. A successful LAN
connection does not verify external TCP/UDP reachability. Share full invitations
only with intended participants: the fragment after `#` contains admission and
E2EE key delivery material.

## Историческая локальная проверка Windows до выпуска API 2

Следующий раздел — исторический порядок проверки до публикации API 2, а не
инструкция установки опубликованных компонентов. Для новой установки используйте
[Debian VPS](SERVER-DEBIAN.md) или [Windows Manager UI](#windows-first-server-setup).
Указанные ниже номера и ограничения review-набора относятся к тому снимку.

Historical pre-publication Windows review procedure; use the current installation
guides above for published releases. Review-build version references below are historical.

Используйте текущие Client, Manager и Server из исходников. Старый опубликованный
Manager API 1 не является совместимым вариантом новой конфигурации. В локальном
установщике пока остаётся номер 0.4.0; смотрите происхождение сборки, а не только имя.

Для подготовки локальных файлов (без установки и запуска служб):

```powershell
node scripts/build-windows-server.mjs --output-dir release/server-api2-candidate
node scripts/build-manager-windows.mjs
node scripts/prepare-windows-api2-review.mjs
```

Для чистой проверки запустите `release/windows-api2-review/Install-API2.cmd`.
Это обычный установщик с локальными проверяемыми пакетами Server/Manager; ему
потребуется ваше подтверждение UAC. Отдельный новый каталог данных указан в README
набора. Набор использует временные локальные review-подписи, не production-ключи;
закрытые signing keys не сохраняются. Так первоначальная установка не скачивает
несовместимые опубликованные компоненты API 1. Автообновление в review выключено.

Остановите клиентский selfhost перед использованием тех же портов. В Manager
проверьте Обзор/настройки/запуск, получите начальное приглашение администратора и
откройте его в review-клиенте. Далее в Обновлениях можно проверить локальный импорт
`PawTalk.Server.0.10.1.pawtalk-server.zip` либо `.windows-x64.zip` из этого набора.
Импорт нового ядра не заменяет обновление старого Manager. SCM/LocalService/UAC
проверяются при реальной установке; подготовка файлов и console tests их не заменяют.

## Windows: first Server setup

The source installer installs Manager only and selects its language. It never
automatically downloads a Server ZIP. On first launch choose a local ZIP/portable
package or explicitly download a compatible published Server in Manager UI, set
IP/ports/history/updates, then confirm installation and start. Local packages are
quarantined and require approval; published downloads retain signature/size/hash
verification. Failed setup keeps its project/data journal for a retry. A Manager
reinstall preserves the existing Server and its running/stopped state.

Установщик из исходников устанавливает только Manager с выбором языка. ZIP ядра
автоматически не скачивается. При первом запуске выберите свой ZIP/переносимый
пакет или явную загрузку совместимого опубликованного Server, настройте сеть,
историю и обновления, подтвердите установку и запуск. Затем можно создать ссылку
первого администратора. При сбое данные сохраняются для повторной попытки.
