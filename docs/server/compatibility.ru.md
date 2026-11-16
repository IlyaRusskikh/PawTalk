# Совместимость опубликованных компонентов

[English](compatibility.en.md) · [Документация](../README.ru.md)

Проверенная 15 ноября 2026 года совместимая комбинация опубликованных **preview API 2**:

| Компонент | Релиз |
| --- | --- |
| Windows Client | [client-v0.12.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.12.1) |
| Постоянный Server | [server-v0.11.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.11.1) |
| Windows/Linux Manager | [manager-v0.5.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.5.1) |

Это **датированная проверенная комбинация, а не закрепление версий для установки**. Для более новых выпусков сверяйте требования в [каталоге загрузок](https://ilyarusskikh.github.io/PawTalk/downloads/) и [описаниях релизов](../../releases/README.ru.md).

API 2 требует серверный API/data schema 2 и обязательное E2EE. **Клиенты и серверы API 1 несовместимы с API 2; автоматической миграции старого членства, истории, паролей и резервных копий нет.** Старые данные сохраняйте отдельно, не импортируя их как API 2. Обновление Manager не заменяет установленный Server автоматически.

У Server и Manager собственные теги выпусков, хотя пакет Manager содержит инструменты Windows и Linux. Отдельного номера версии Manager для каждой ОС нет.
