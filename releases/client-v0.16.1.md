# PawTalk Client 0.16.1 — Screen sharing improvements

Preview. Changes since Client 0.16.0.
Предварительный выпуск. Изменения относительно Client 0.16.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.16.1/PawTalk.Setup.0.16.1.exe)

## Русский

### Изменено

- Можно выбрать свёрнутое окно и сменить источник во время стрима. Единственный подключённый монитор выбирается автоматически. Длинные названия окон помещаются в одну строку.
- В режиме **Исходное** окно или монитор захватывается без ограничения разрешения со стороны меню. Выбранная частота кадров задаёт верхний предел стрима. PawTalk отдаёт приоритет чёткости и переключается на плавность при длительной нагрузке.
- Наведите курсор на красную плашку **Стримит** в списке участников голосового канала, чтобы увидеть превью без звука. Полноэкранный просмотр сохраняется при кратких перебоях и закрывается при завершении стрима.

### Установка и обновление

Обновите Client или запустите установщик Windows x64. Если на постоянном хосте уже работает Server 0.15.0 с демонстрацией экрана, обновлять или перезапускать Server и Manager для этого выпуска не нужно. Для временных комнат используйте хост с поддержкой демонстрации экрана. Чтобы получить все изменения, обновите Client у стримера и зрителей.

## English

### Changed

- Select minimized windows, change the source during a stream and automatically select the display when only one is connected. Long window titles fit on one line.
- **Original** captures at the source size without a resolution cap in the picker. The selected frame rate is used as the stream’s upper limit. PawTalk prioritizes detail under normal conditions and switches to smoother motion under sustained load.
- Hover over the red **Streaming** badge in the voice channel sidebar for a silent preview. Full-screen viewing survives brief interruptions and closes when the stream ends.

### Install or update

Update Client or run the Windows x64 installer. If your permanent host already runs Server 0.15.0 with screen sharing, this update requires no Server or Manager upgrade or restart. For temporary rooms, use a host with screen sharing support. Update both the presenter’s and the viewers’ Clients to get all the changes.

## Ограничения / Limitations

Windows может не захватывать отдельные окна игр в эксклюзивном полноэкранном режиме. В этом случае используйте оконный режим без рамок или демонстрацию монитора. Фактическое разрешение и частота кадров зависят от источника, нагрузки и соединения. Захват звука приложения зависит от сборки Windows и может включать звук других окон того же приложения. У EXE нет подписи Authenticode.

Windows may be unable to capture some games in exclusive fullscreen as a window. Use borderless windowed mode or share the monitor in that case. Actual resolution and frame rate depend on the source, system load and connection. Application audio capture depends on the Windows build and may include audio from other windows of the same application. The EXE has no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.16.1.exe · PawTalk.Licenses.0.16.1.zip · SHA256SUMS.txt · update-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.16.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.16.1/LICENSE)
