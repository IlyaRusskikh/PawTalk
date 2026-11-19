# PawTalk Client 0.14.1 — Chat fixes

Preview for Windows x64. Changes since Client 0.14.0.
Предварительный выпуск. Изменения относительно Client 0.14.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.14.1/PawTalk.Setup.0.14.1.exe)

## Русский

### Исправлено

- Голосовое сообщение можно отправить прямо во время записи. При ошибке отправки запись остаётся в черновике для повторной попытки.
- Вложенные GIF воспроизводятся прямо в чате. Исправлено распознавание локализованных ссылок Tenor.
- Фото сохраняют пропорции в превью, переключатель предпросмотра выровнен, а переход к свежим сообщениям работает и при подгрузке истории.
- Чат с непрочитанными сообщениями открывается на первом непрочитанном, даже если оно находится за пределами последней страницы истории.

### Установка и обновление

Используйте обновление Client или скачайте установщик Windows x64. Для расширенных вложений и интерактивных списков подходит Server 0.13.0.

## English

### Fixed

- Voice messages can be sent while recording. If sending fails, the recording stays in the draft for retry.
- GIF attachments play inline in chat. Localized Tenor links resolve correctly.
- Photo previews preserve their aspect ratio, the preview toggle is centered, and jumping to the newest messages works while history is loading.
- Chats with unread messages open at the first unread message, even when it is outside the newest page of history.

### Install or update

Use Client updates or download the Windows x64 installer. Server 0.13.0 supports extended attachments and interactive checklists.

## Ограничения / Limitations

Воспроизведение GIF по внешним ссылкам зависит от доступности провайдера. EXE без Authenticode.

GIF playback from external links depends on provider availability. The EXE has no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.14.1.exe · PawTalk.Licenses.0.14.1.zip · SHA256SUMS.txt · update-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.14.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.14.1/LICENSE)
