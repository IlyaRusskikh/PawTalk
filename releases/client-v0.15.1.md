# PawTalk Client 0.15.1 — Chat and Windows notifications

Preview. Changes since Client 0.15.0.
Предварительный выпуск. Изменения относительно Client 0.15.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.15.1/PawTalk.Setup.0.15.1.exe)

## Русский

### Изменено

- Панель форматирования открывается при выделении текста. Отправленное сообщение перелетает из поля ввода в ленту, а лента удерживает его в видимой области. Поле редактирования растёт до заданной высоты. При отправке и сохранении правок клиент обрезает пробелы по краям и оставляет до трёх переносов подряд.
- Галерея открывает вложения одного сообщения. Фото можно листать кнопками и стрелками клавиатуры. Поддерживаемые исходные фото и видео могут занимать до 128 МиБ. Если файл превышает лимит загрузки, клиент сжимает фото в WebP, а видео длительностью до двух минут — в WebM.
- На панели задач Windows отображается логотип PawTalk с красным счётчиком активных уведомлений. Уведомления показывают фото отправителя, включая WebP, либо инициал. Проверенные упоминания ролей используют цвет роли.

### Установка и обновление

Обновите Client или запустите установщик Windows x64. Для цветов ролей в защищённых чатах обновите постоянный Server до 0.14.2 или используйте временную комнату этого Client. Существующие постоянные комнаты API 2 поддерживаются.

## English

### Changed

- Selecting text opens the formatting toolbar. Sent text animates from the composer into the chat, and the feed keeps it in view. The edit field grows to a fixed maximum height. Sending and saving edits trims outer whitespace and limits consecutive line breaks to three.
- The viewer opens attachments from the same message. Use the gallery buttons or arrow keys to browse photos. Supported source photos and videos can be up to 128 MiB. If a file exceeds the upload cap, Client compresses photos to WebP and videos up to two minutes to WebM.
- The Windows taskbar uses the PawTalk logo with a red active-notification badge. Windows notifications show the sender’s photo, including WebP, or their initial. Verified role mentions use the role’s color.

### Install or update

Update Client or run the Windows x64 installer. For role colors in protected chats, update permanent Server to 0.14.2 or use a temporary room created by this Client. Existing permanent API 2 rooms are supported.

## Ограничения / Limitations

Лимит загрузки составляет 2 МиБ для PNG/JPEG/WebP и до 50 МиБ для остальных файлов на совместимых серверах. На старых серверах API 2 лимит составляет 2 МиБ на файл. EXE без Authenticode.

The upload cap is 2 MiB for PNG/JPEG/WebP and up to 50 MiB for other files on compatible servers. Older API 2 servers have a 2 MiB per-file cap. The EXE has no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.15.1.exe · PawTalk.Licenses.0.15.1.zip · SHA256SUMS.txt · update-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.15.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.15.1/LICENSE)
