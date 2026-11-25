# Описания релизов

[English](README.md) · [История изменений](../changelog/README.ru.md)

Двуязычные `<tag>.md` — канонические локальные исходники для публикации, перенесённые без изменений при обновлении документации; `<tag>.en.md` и `<tag>.ru.md` предназначены для чтения на одном языке. План кандидата фиксирует digest канонического исходника. Неудачные кандидаты **не являются** опубликованными версиями.

Локальный исходник не обязательно совпадает с публичным описанием Release. Аудит 17 ноября 2026 обнаружил, что у `client-v0.12.1`, `server-v0.11.1` и `manager-v0.5.1` на GitHub ещё есть временные формулировки публикации/CI, уже убранные локально. Для сравнения используйте `node scripts/check-release-notes.mjs --published <tag>`; исправление публичного текста требует [отдельного разрешения владельца](../architecture/release-recovery.ru.md). Не перезаписывайте исходники или публичные описания ради сокрытия расхождения.

## Client

- [client-v0.9.0](client-v0.9.0.ru.md)
- [client-v0.10.0](client-v0.10.0.ru.md)
- [client-v0.10.1](client-v0.10.1.ru.md)
- [client-v0.11.0](client-v0.11.0.ru.md)
- [client-v0.12.0](client-v0.12.0.ru.md) — неопубликованный неудачный кандидат
- [client-v0.12.1](client-v0.12.1.ru.md)
- [client-v0.13.0](client-v0.13.0.ru.md) — исходник выпуска
- [client-v0.14.0](client-v0.14.0.ru.md) — источник выпуска
- [client-v0.14.1](client-v0.14.1.ru.md)
- [client-v0.15.0](client-v0.15.0.ru.md)
- [client-v0.15.1](client-v0.15.1.ru.md)
- [client-v0.15.2](client-v0.15.2.ru.md)
- [client-v0.15.3](client-v0.15.3.ru.md)
- [client-v0.16.0](client-v0.16.0.ru.md)

## Server

- [server-v0.9.0](server-v0.9.0.ru.md)
- [server-v0.10.1](server-v0.10.1.ru.md)
- [server-v0.11.0](server-v0.11.0.ru.md) — неопубликованный неудачный кандидат
- [server-v0.11.1](server-v0.11.1.ru.md)
- [server-v0.12.0](server-v0.12.0.ru.md) — исходник выпуска
- [server-v0.13.0](server-v0.13.0.ru.md) — источник выпуска
- [server-v0.14.0](server-v0.14.0.ru.md)
- [server-v0.14.1](server-v0.14.1.ru.md)
- [server-v0.14.2](server-v0.14.2.ru.md)
- [server-v0.14.3](server-v0.14.3.ru.md)
- [server-v0.15.0](server-v0.15.0.ru.md)

## Manager

- [manager-v0.1.0](manager-v0.1.0.ru.md)
- [manager-v0.2.0](manager-v0.2.0.ru.md)
- [manager-v0.2.1](manager-v0.2.1.ru.md)
- [manager-v0.3.0](manager-v0.3.0.ru.md)
- [manager-v0.4.0](manager-v0.4.0.ru.md)
- [manager-v0.5.0](manager-v0.5.0.ru.md) — неопубликованный неудачный кандидат
- [manager-v0.5.1](manager-v0.5.1.ru.md)
- [manager-v0.6.0](manager-v0.6.0.ru.md)
- [manager-v0.7.0](manager-v0.7.0.ru.md)
- [manager-v0.7.1](manager-v0.7.1.ru.md)

[Опубликованные GitHub Releases](https://github.com/IlyaRusskikh/PawTalk/releases) определяют доступность тегов. Не используйте один общий `releases/latest`.
