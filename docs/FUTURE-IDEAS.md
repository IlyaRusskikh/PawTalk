# Будущие идеи / Future ideas

## Измерения API 2 / API 2 measurements

Обновить сравнительный CPU/latency benchmark под обязательное E2EE и членство API 2.
Старый harness API 1 с plaintext/E2EE вариантами удалён вместе с замещённым ядром;
исторические отчёты не пересчитываются и не выдаются за измерения нового протокола.
Текущая приёмка проверяет реальный RTP/Opus, gain/mute/PTT/rejoin и E2EE; новых
численных обещаний производительности из этих функциональных тестов не следует.

Это список идей для последующего обсуждения, а не утверждённый план, обещание
сроков или описание реализованных возможностей. Перед реализацией каждой идеи
нужно отдельно согласовать поведение, архитектуру, безопасность и объём работы.

This is a backlog for discussion, not an approved implementation plan, delivery
commitment, or description of shipped features. Each idea needs a separate scope,
behavior, architecture, and security review before implementation.

## IDEA-001 — Личные сообщения через общие серверы / Direct messages through shared servers

Добавлено / Added: 2026-11-14. Статус / Status: идея, не запланировано / proposed, unscheduled.

### Идея

Личные сообщения между пользователями без единого центрального сервера сообщений.
Если у отправителя и получателя есть общие серверы PawTalk, клиент выбирает
ближайший доступный общий сервер и использует его как посредника доставки.
Публичный ID профиля помогает узнавать собеседника между серверами, но сам по себе
не доказывает владение профилем и не раскрывает список его серверов.

Содержимое личных сообщений должно иметь отдельное E2EE между собеседниками:
общий сервер пересылает шифротекст, а ключ канала сервера не даёт права читать ЛС.
Это проектное требование, а не уже реализованная гарантия.

### Открытые вопросы

- Что означает «ближайший»: задержка, доступность, нагрузка; как выбирать и менять маршрут?
- Как подтверждать личность собеседника и его устройства, менять и отзывать ключи?
- Как находить общие серверы с согласия пользователей без раскрытия остальных серверов?
- Как доставлять сообщения офлайн: хранение, TTL, лимиты и ответственность посредника?
- Как обеспечивать подтверждения доставки, порядок, дедупликацию и повтор при смене маршрута?
- Как блокировать нежелательные ЛС, спам и злоупотребления ресурсами посредника?
- Как членство, выход и бан влияют на возможность использовать сервер для доставки ЛС?
- Нужна ли вообще пересылка между серверами? Выбор одного общего посредника ещё не является mesh-маршрутизацией.

### English

Explore direct messages without a single central messaging service. When both
users belong to shared PawTalk servers, select the nearest available shared
server as a delivery relay. A public profile ID enables recognition across
servers; it neither authenticates its holder by itself nor reveals memberships.

Require separate sender-to-recipient E2EE: relays forward ciphertext, and possession
of a shared server/channel key must not grant access to direct messages. This is
a design requirement, not an implemented security guarantee.

Open decisions include route selection/failover; identity and device-key verification
and revocation; consent-based shared-server discovery; offline storage, TTL and
quotas; acknowledgements, ordering and deduplication; spam and resource abuse;
membership/ban behavior; and whether inter-server forwarding is needed at all.
Selecting one shared relay alone is not a mesh routing protocol.

## IDEA-002 — Вклады общих серверов в ключ ЛС / Shared-server contributions to a DM key

Добавлено / Added: 2026-11-14. Статус / Status: гипотеза для исследования / research proposal.

### Предложение пользователя

При добавлении в друзья через общий сервер этот сервер генерирует одинаковый
случайный секрет для обоих пользователей, передаёт им и не сохраняет его.
Другие общие серверы могут независимо выдавать дополнительные секреты.
Пользовательское название идеи — «усиление ключа». Уточнение: при двух и более
серверах клиенты локально смешивают независимые вклады стандартной KDF в один
конечный ключ. Вклады и конечный ключ сохраняются на устройствах; конечный ключ
никогда не передаётся серверам. Одинаковый алгоритм и согласованный набор вкладов
дают обоим собеседникам одинаковый результат. Цель — не дать отдельному серверу,
знающему только свой вклад, вычислить конечный ключ.
Это дополнение к IDEA-001, а не согласованный протокол или обещание большей стойкости.

### Что требуется проверить

- Сервер знает свой вклад при генерации; обещание забыть его не является
  криптографической гарантией. При одном серверном секрете сервер мог сохранить ключ.
- Несколько вкладов могут разделить доверие только при явно заданных предположениях
  о независимости серверов, отсутствии сговора и безопасной доставке вкладов.
  Если хотя бы один необходимый вклад остаётся достаточно случайным и неизвестным
  атакующему, корректная схема смешивания должна сохранять секретность результата.
  Требуется выбрать и проверить конкретную конструкцию; число серверов само по себе
  не гарантирует защиту при сговоре или общей компрометации.
- Выбрать стандартную KDF и однозначное кодирование/порядок вкладов с контекстом
  собеседников и версии ключа; не проектировать криптопротокол без анализа.
- Рассмотреть клиентское согласование секрета между собеседниками, при котором
  серверы только доставляют сообщения и не узнают конечный ключ. Серверные вклады
  могут обсуждаться как дополнительный механизм, не обязательная основа E2EE.
- Определить проверку личности и устройств, согласование одинакового набора вкладов,
  версии ключей, историю, офлайн-доставку и добавление новых устройств.
- Решить поведение при недоступности общего сервера, выходе с него, смене маршрута,
  утечке вклада и попытке навязать устаревший или неполный набор вкладов.
- Примирить эту гипотезу с требованием IDEA-001 о конфиденциальности от посредника.

### English

User proposal: when two users become friends through a shared server, that server
generates and sends the same random secret to both clients, then discards it.
Additional shared servers contribute independent secrets. The proposed feature
name is “key strengthening”. Clarification: with two or more servers, both clients
locally combine an agreed set of contributions using a standard KDF into one final
key. Contributions and the final key stay on devices; the final key is never sent
to servers. A server that knows only its own contribution should not be able to
derive the result.

This is a research candidate, not an approved protocol or a security claim.
Each contributing server initially knows its secret, and deletion cannot be
cryptographically enforced. Multiple contributions require explicit independence,
non-collusion and delivery assumptions; more servers do not automatically improve
security. Select and review a concrete KDF construction with canonical contribution
ordering/encoding and peer/key-version context. At least one required contribution
must remain unpredictable and unknown to an attacker. Also consider client-to-client
key agreement that keeps the final secret unknown to relays.
Resolve authentication, device support, contribution-set agreement, key versions,
history, offline delivery, outages, membership changes and downgrade prevention.
Reconcile the candidate with IDEA-001's relay-confidentiality requirement.

## IDEA-003 — Разделение голосового ввода/вывода между устройствами / Split voice input and output

Добавлено / Added: 2026-11-14. Статус / Status: идея, не запланировано / proposed, unscheduled.

В будущем разрешить связанным устройствам одного профиля совместную голосовую
сессию: одно воспроизводит звук, другое записывает и передаёт микрофон.
В текущем обновлении в голосе допускается только одно устройство профиля.

Потребуется согласовать управление сессией и громкостью, задержку, синхронизацию,
PTT/mute/deafen, восстановление после обрыва, предотвращение эха и выдачу ключей
обоим устройствам. Функция не означает несколько независимых голосовых каналов.

Future proposal: split a linked profile's voice input and output across devices,
using one device for playback and another for microphone capture/transmission.
Current scope permits one voice device. Review session control, latency, sync,
PTT/mute/deafen, reconnection, echo prevention and key delivery; this does not imply
simultaneous participation in independent voice channels.
