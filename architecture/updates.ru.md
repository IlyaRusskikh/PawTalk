# Подписанные обновления и доверие к поставке

[English](updates.en.md) · [Индекс](README.ru.md)

Client, Server и Manager **имеют независимые версии и подписи**. Теги Client — `client-v*`, Server — `server-v*`, Manager — `manager-v*`. Источник опубликованных версий — GitHub Releases соответствующего семейства; версии `package.json` и общий `releases/latest` не подходят.

Обновлятор Client проверяет подписанный Ed25519-манифест, хеш/размер файла, компонент/версию/канал. Server использует собственные Ed25519 trust roots, подписанные метаданные и OCI digest для `ghcr.io/ilyarusskikh/pawtalk-server`. У Manager отдельные ключи доверия и манифесты Windows installer/Linux bundle; Linux Manager проверяет выпуски, digest, API/data version и installed state до изменения runtime.

Обновление должно отклонять неправильные корни/подписи/хеши, просроченный или чужой манифест, неверный репозиторий, несовместимую схему и семейство. Хостовый контроллер при необходимости проводит транзакцию с backup/rollback. Не отключайте подписи ради обхода проверки.

Обновление существующего Manager **не заменяет Server автоматически**, пока отдельное обновление Server не разрешено/запущено. Автоматический поиск Linux включает опубликованные prerelease. [Выпуск релизов](releasing.ru.md) · [Совместимость](../docs/server/compatibility.ru.md).
