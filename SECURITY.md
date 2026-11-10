# Security policy / Политика безопасности

[Русский](#русский) · [English](#english)

## Русский

### Поддерживаемые версии

PawTalk находится в стадии **публичного предварительного выпуска**, а не стабильного релиза. На 10 ноября 2026 года актуальная версия — [0.7.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.7.1). Исправления безопасности, если они потребуются, выпускаются в новых версиях; исправление всех предыдущих версий отдельно **не гарантируется**.

### Как сообщить об уязвимости

Пожалуйста, **не создавайте публичный Issue с работающим эксплойтом, секретами или подробностями неисправленной уязвимости**.

1. Откройте вкладку **Security** репозитория и проверьте, доступна ли кнопка **Report a vulnerability** (приватное сообщение через GitHub Security Advisories).
2. Если приватная отправка доступна, используйте её. Укажите затронутые версии, ожидаемое и фактическое поведение, способ безопасно воспроизвести проблему и возможные последствия. Не прикладывайте настоящие пароли, ключи или действующие приглашения.
3. Если приватная отправка недоступна, не публикуйте детали в Issues. Можно создать обычный Issue **только с просьбой предоставить приватный канал**, без технических подробностей.

Время ответа и срок исправления пока не гарантируются. Исправления публикуются отдельными релизами, без замены старых тегов или бинарников.

### Важные ограничения

- E2EE **экспериментально и выключено по умолчанию**. Общий ключ не обновляется автоматически при уходе участника; защиты прошлых разговоров после последующей компрометации общего ключа (forward secrecy) нет. [Модель E2EE](docs/E2EE.md).
- Без E2EE медиасервер может получить доступ к аудио, а сервер — читать сохранённый чат.
- Windows-установщик пока не имеет Authenticode-подписи. SHA-256 и подпись Ed25519 манифеста обновлений проверяют другие свойства и не являются подписью издателя Windows. [Обновления](docs/UPDATES.md).
- Реальные микрофоны, игры/PTT, внешние сети и нагрузка до 30 участников ещё требуют аппаратной приёмки. [План проверки](docs/ACCEPTANCE.md).

## English

### Supported versions

PawTalk is a **public preview**, not a stable release. As of November 10, 2026, the current release is [0.7.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.7.1). Security fixes, when necessary, are shipped in new releases; backports to every older version are **not guaranteed**.

### Reporting a vulnerability

Please **do not open a public issue containing working exploits, secrets, or details of an unpatched vulnerability**.

1. Open this repository's **Security** tab and look for **Report a vulnerability** (GitHub private vulnerability reporting).
2. If available, report privately. Include affected versions, expected and actual behavior, safe reproduction steps, and impact. Never attach real passwords, keys, or live invitations.
3. If private reporting is unavailable, do not post the vulnerability details in Issues. You can open a normal issue **requesting a private contact channel only**, with no technical vulnerability details.

Response times and fix timelines are not guaranteed. Security fixes are shipped as new releases rather than overwriting existing tags or binaries.

### Known limitations

- E2EE is **experimental and disabled by default**. There is no automatic key rotation when a participant leaves and no forward secrecy for old sessions if a shared key is later compromised. [E2EE model](docs/E2EE.md).
- Without E2EE, the media server can access audio and the server can read stored chat.
- Windows installers are not yet Authenticode-signed. Published SHA-256 checksums and Ed25519-signed update manifests serve different purposes and do not replace a Windows publisher signature. [Updates](docs/UPDATES.md).
- Hardware acceptance remains open for physical microphones, game/PTT behavior, external networks, and 30-participant loads. [Acceptance checklist](docs/ACCEPTANCE.md).
