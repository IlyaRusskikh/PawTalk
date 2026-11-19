# Установка Server Manager в Windows

[English](installation.en.md) · [О Manager](../overview.ru.md)

**Назначение:** Manager устанавливается на компьютере, где будет работать постоянный Windows Server. Это не приложение для вступления в голосовые каналы. Опубликованный Manager предназначен для Windows x64; Windows 10/11 и Windows Server 2019/2022/2025 входят в целевые платформы, но объём проверок на них разный.

1. Скачайте **Manager** из [опубликованного каталога](https://ilyarusskikh.github.io/PawTalk/downloads/#manager), не путайте с Client и Server ZIP.
2. Проверьте подписанные метаданные/контрольные суммы и ограничения выбранного выпуска. Установщик Manager позволяет выбрать язык интерфейса.
3. Запустите установщик с правами, которые запрашиваются для управления службами. Во время установки службы Windows может показать UAC.
4. Откройте Manager и переходите к [первой настройке Server](first-server.ru.md). **Установка Manager сама по себе ничего не скачивает и не устанавливает из Server.**

Manager управляет жизненным циклом и конфигурацией **Server**, а сам Server обслуживает участников, голос и чат. Повторная установка Manager сохраняет существующий Server и его состояние запуска/остановки, а не сбрасывает данные.

Для работы Manager и Server нужен совместимый опубликованный API/data schema 2. [Совместимость](../../server/compatibility.ru.md).

## Установка TUI на Windows 11 и Windows Server Core

На странице выпуска Manager выберите файл
`PawTalk.Server.Manager.TUI.Setup.<version>.exe`, если он есть в списке. В него
входят консольный хост и встроенный Python. При установке поверх графической
редакции установщик удаляет приложение, трей и их ярлыки, сохраняя данные и
настройки Server. Автообновления Manager учитывают установленную редакцию.

Запустите проверенный установщик в тихом режиме из PowerShell от имени
администратора. Подставьте имя скачанного файла.

```powershell
$setup = (Resolve-Path '.\PawTalk.Server.Manager.TUI.Setup.<version>.exe').Path
$install = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Manager installation failed ($($install.ExitCode))" }
& "$env:ProgramData\PawTalk Server Manager\pawtalkctl.exe" tui
```

В разделе **Обзор → Установить первый сервер** можно выбрать опубликованный Server
или локальный ZIP-пакет Server для Windows. Для запуска на русском используйте
`pawtalkctl.exe --lang ru tui`. [Управление в терминале](management.ru.md).
