# Server Manager для Windows и Linux

[English](overview.en.md) · [Документация](../README.ru.md)

**PawTalk Server Manager** устанавливает и обслуживает **постоянный** PawTalk Server. Это не альтернативный клиент голосового общения. Windows- и Linux-варианты входят в **одно семейство релизов Manager** и используют общий номер версии `manager-v*`.

В **Windows** Manager устанавливается как обычное приложение. В Electron-интерфейсе можно импортировать локальный пакет Server или явно загрузить проверенный опубликованный Server, задать параметры и управлять нативной службой.

В **Linux** установленная команда `pawtalkctl` управляет подписанным серверным контейнером через Docker Engine, Compose plugin и таймеры systemd. Официально поддерживаемый сценарий новой установки — Debian 12 и Ubuntu 24.04 LTS на amd64/arm64.

Сам установщик/пакет Manager не устанавливает и не обновляет запущенный Server без согласия. Server и Manager выпускаются отдельно. Backup содержит данные сервера и подписанные квитанции, но не клиентские E2EE-ключи.

[Windows](windows/installation.ru.md) · [Linux](linux/installation.ru.md) · [Совместимость](../server/compatibility.ru.md).
