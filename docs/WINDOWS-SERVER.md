# Permanent Windows server / Постоянный Windows-сервер

**0.9.0 development, unreleased / В разработке, не опубликовано.**
Целевые ОС: Windows 10/11 x64 и Windows Server 2019/2022/2025 x64.
Это матрица целей, а не утверждение о проверке всех этих ОС.
На локальной машине проверяется настоящий Go/LiveKit, SQLite, Ed25519 и Windows
job lifecycle. Регистрация SCM, LocalService ACL и автозапуск проверяются отдельным
Windows CI-тестом на Windows Server 2022 и 2025: службы, EXE-установка и удаление
с сохранением данных прошли. Windows 10/11 и Server 2019 отдельно не проверялись.
Реальный внешний TCP/UDP и голос между физическими устройствами не проверены.

## Установка

После выпуска скачайте `PawTalk.Server.Manager.Setup.X.Y.Z.exe` из `manager-vX.Y.Z`.
Запустите EXE с правами администратора, выберите язык и заполните настройки:
публичный IPv4, порт, шифрование, SHA-256 key ID (не секретный ключ), лимит истории
и общий переключатель автообновления сервера/Manager. Шифрование и обновления
по умолчанию включены. В конце консоль покажет приглашение и первый пароль;
сохраните их приватно перед закрытием окна. Пароль выдаётся один раз.
Повторная установка сохраняет существующую комнату и её настройки.
При повторной установке EXE службы временно останавливаются для замены bootstrap
runtime/host; это прерывает звонок. Обычное обновление кода Manager сервер не останавливает.

Python встроен в установщик. Docker, WSL, Node.js и отдельная установка Python
не требуются. Настоящие подписанные Server/Manager релизы и заранее настроенные
корни доверия обязательны. Публичные ключи в `manager/trust.json` настроены;
production-установка требует публикации подписанных релизов, как и на Linux.

По умолчанию программа находится в `%ProgramFiles%\PawTalk Server Manager`,
данные/конфигурация/backup — в `%ProgramData%\PawTalk`.
Каталог служб должен быть непосредственным дочерним каталогом настоящего
системного ProgramData; произвольный пользовательский Temp/Desktop не принимается.
Папка программы фиксирована в защищённом Program Files.
Службы `PawTalkServer-<root hash>` и `PawTalkManager-<root hash>` запускаются
автоматически. Server использует LocalService; Manager — LocalSystem для
управления службами и защищёнными файлами. Обычные пользователи не могут менять
код, конфигурацию и архивы. LocalService может читать код/конфигурацию и изменять
только каталоги данных сервера и его логов.

Нужны входящие TCP `PORT`, TCP `PORT+1`, UDP `PORT+2` (18443/18444/18445).
`PORT+3` — только loopback. Установщик не меняет Windows Firewall, роутер и правила
провайдера; настройте эти входящие порты сами. При CGNAT одной установки EXE
недостаточно для связи извне. Арендовать VPS необязательно: подходит свой постоянно
работающий компьютер с доступным IP и портами.

## Обслуживание

Ярлыки **Status** и **Configure** в меню Пуск запрашивают повышение прав.
Либо откройте PowerShell от администратора:

```powershell
$ctl = "$env:ProgramFiles\PawTalk Server Manager\pawtalkctl.exe"
& $ctl status
& $ctl doctor
& $ctl setup
& $ctl configure PAWTALK_CHAT_MAX_MB=256 --yes
& $ctl update check
& $ctl update now
& $ctl manager check
& $ctl manager now
& $ctl backup create
& $ctl backup list
& $ctl backup restore backup-012345abcdef --yes
& $ctl logs
& $ctl uninstall --keep-data --yes
```

Имя backup — пример. Удаление останавливает службы и сохраняет программу, данные,
настройки и резервные копии для восстановления. Оно не удаляет посторонние файлы.
Для восстановления в новой директории сначала выполните `status` с выбранным
`--root`, чтобы создать защищённую структуру; затем скопируйте туда полный backup
в `var\backups\pawtalk` и выполните `backup restore`. Чужая непустая директория
без метки владения не принимается; ссылки/junction внутри managed root запрещены.

## Общая логика с Linux

Обе ОС используют `manager/pawtalk_manager/controller.py`: lock, транзакционный
журнал, остановленная согласованная копия, проверка здоровья/TLS identity,
восстановление пары «версия сервера + данные» при ошибке и защита от downgrade.
На Linux runtime — Docker Compose, на Windows — нативные Go/LiveKit EXE и SCM.
Это одинаковое серверное ядро из исходников `server/`, а не Linux Docker-образ
внутри Windows. Временные комнаты клиента по-прежнему используют свой pin.

Сервер проверяется по `server-v*`, Manager — по `manager-v*`; канала выбора нет.
Manager обновляет свой проверенный общий bundle без перезапуска сервера.
Установленный Python runtime и минимальный Go SCM launcher относятся к стабильному
bootstrap protocol 1; их замена требует повторной установки Manager EXE. Это
отдельно от автоматического обновления Python-кода Manager. Linux также не
обновляет системный Python и стабильный launcher через bundle.

Backup предназначен для восстановления на той же ОС. Межплатформенный перенос
Linux ↔ Windows не заявлен: у ОС разные runtime receipts и пути хранения.

## Сборка и проверки

```powershell
npm run server:prepare
node scripts/build-windows-server.mjs
node scripts/build-manager-windows.mjs
node scripts/windows-manager-smoke.mjs
# Администратор: реальные SCM-службы с отдельными именами и временными данными.
node scripts/windows-manager-smoke.mjs --scm
# CI / чистая тестовая Windows: настоящий silent EXE и uninstaller.
node scripts/windows-manager-smoke.mjs --scm --installer
```

Сборка ничего не публикует. В smoke используются временные ключи и локальные
архивы; production origin и подписи проверяются отдельными контрактными тестами.
Без `--scm` проверяется тот же сервисный цикл через консольный host/job, но не SCM.
`--scm` требует администратора и не подменяет отсутствие прав успешным skip.
`--installer` требует чистой машины без установленного Server Manager, временно
устанавливает продукт в Program Files и проверяет настоящий uninstaller. При
существующей программе, ярлыках или регистрации этот тест отказывается их менять.
Тестовые службы используют отдельные каталоги ProgramData; их пути проверяются
перед очисткой. Jobs Windows Server 2022/2025 запускают оба режима установки.

## English

The unreleased Windows installer targets Windows 10/11 and Server 2019/2022/2025
x64. It bundles Python and needs no Docker/WSL/Node installation. These OS targets
still require actual OS-specific verification.
Windows Server 2022/2025 CI passed actual SCM service and EXE install/uninstall
checks; Windows 10/11 and Server 2019 remain unverified. Run the EXE as Administrator and
configure IP, ports, E2EE key ID, history and automatic updates. Save the invitation
and one-time password shown at the end. Configure external TCP/UDP and Windows
Firewall yourself. The same Manager controller handles signatures, backup,
transactions, rollback and updates on both OSes; only runtime/service adapters
differ. Windows uses native Go/LiveKit executables, not the Linux Docker image.
Use the commands above from elevated PowerShell or the Start-menu shortcuts.
The stable bootstrap runtime/SCM host is serviced by reinstalling the Manager EXE;
automatic Manager bundle updates replace its shared Python policy code.
Uninstall retains tools, config, data and backups. Cross-OS backup migration and
real-device external-network verification are not claimed.
