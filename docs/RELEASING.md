# Независимые выпуски / Independent releases

**Выпущены Client 0.11.0, Server 0.10.1, Manager 0.4.0 и Client bridge v0.8.1.**
Manager 0.4.0 опубликован: [заметки и файлы](releases/manager-v0.4.0.md), [успешный tag CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43371241627). Client/Server не меняют версии вместе с ним.

Все три текущие линии опубликованы как preview; подписи и скачанные assets проверены.
Проверка тега `server-v0.10.0` остановилась до публикации из-за зависимости
server-only Electron smoke от Client dist. Тег не заменяется; исправление выпущено в 0.10.1.
Версии независимы. После принятого Server Manager и Client можно выпускать параллельно
из одного проверенного коммита; каждый тег сохраняет собственный workflow и artifacts.
Сначала branch/PR CI и ревью, затем отдельное разрешение на merge и component tags.
Текущий Client: [client-v0.11.0](releases/client-v0.11.0.md); текущий Manager: [manager-v0.4.0](releases/manager-v0.4.0.md); патч Server: [RELEASE-NOTES-0.10.1](RELEASE-NOTES-0.10.1.md); исходный порядок server-first: [RELEASE-NOTES-0.10.0](RELEASE-NOTES-0.10.0.md).
Локальные сборки используют `--publish never`. Push/tag/release требуют отдельного
разрешения владельца. Опубликованные теги, EXE и образы не заменяются.

| Компонент | Источник версии | Тег | Артефакты |
|---|---|---|---|
| Client | `package.json` + обе версии `package-lock.json` | `client-vX.Y.Z` | EXE, `update-manifest.json`, SHA256SUMS, ZIP лицензий |
| Server | `server/VERSION` | `server-vX.Y.Z` | GHCR Linux amd64/arm64 image, `PawTalk.Server.X.Y.Z.windows-x64.zip`, подписанный `server-manifest.json` |
| Manager | `manager/VERSION` + `manager/desktop/package.json` | `manager-vX.Y.Z` | Общий `PawTalk.Manager.X.Y.Z.tar.gz`, Windows `PawTalk.Server.Manager.Setup.X.Y.Z.exe`, подписанный `manager-manifest.json` |

Client, Server и Manager используют независимые версии. Patch — небольшие исправления,
minor — существенные функции, major — очень крупные изменения; нижние компоненты
сбрасываются. Версию поднимают при подготовке выпуска, не на каждом рабочем изменении.
Заметки ведутся в общем `CHANGELOG.md` с указанием компонента.

## Описание каждого релиза / Release notes for every tag

До push тега подготовьте и проверьте `docs/releases/<tag>.md`, например
`docs/releases/client-v0.10.1.md`. Это полный текст GitHub Release, а не ссылка
на PR или автоматически сгенерированный список коммитов. Сравнивайте с предыдущим
выпуском **того же компонента**; для первого выпуска перечислите его возможности.
Описывайте результат для пользователя, не внутреннюю историю разработки.

Обязательный порядок:

1. Компонент, версия, stable/preview, краткая цель и прямая ссылка на установщик
   либо Server ZIP/Linux image.
2. **Русский:** «Добавлено», «Исправлено», «Изменено» — только непустые разделы,
   понятные пункты с конкретным поведением до/после. Затем «Установка и обновление»:
   что установить, сохраняются ли данные, будет ли перерыв, какие другие компоненты
   нужно обновить и есть ли миграция.
3. **English:** тот же набор изменений и требований без пропущенных условий.
4. Ограничения и известные проблемы именно этого выпуска. Не переносите исправление
   из следующего тега в старый релиз; не выдавайте синтетические проверки за аппаратную
   или внешнесетевую приёмку. Отличайте подпись update manifest от Authenticode EXE.
5. Точные файлы, способ проверки, исходники/CHANGELOG/руководство **этого тега**,
   лицензия и ссылка на фактически успешный tag CI, когда он завершён.

Не заполняйте пустые категории фразами «нет изменений» и не подменяйте заметки
ссылкой на общий changelog. Основа стиля — подробные релизы `v0.7.0`/`v0.8.0`;
готовые примеры для независимых компонентов находятся в [releases/](releases/).
Заголовок GitHub Release должен называть компонент, версию и главную тему.

Workflow требует непустой файл заметок до сборки и публикует его через
`--notes-file`, без `--generate-notes`. После публикации проверьте отображённый текст,
ссылки и соответствие файлу; подтверждённые результаты CI можно добавить в файл и
описание после завершения выпуска. Редактирование описания не меняет теги, бинарники,
хэши, даты выпуска или stable/preview flags.

Before tagging, review a complete bilingual `docs/releases/<tag>.md`. Lead with the
component/version and user benefit; group actual additions, fixes and changes since
the previous release of that component, omitting empty groups. Include upgrade/data/
downtime and cross-component requirements, accurate limitations, exact downloads,
verification, source/license links pinned to the tag and confirmed tag CI when available.
Russian and English must convey the same changes and conditions. Publish this file
with `--notes-file`; generated PR/commit lists are insufficient. Keep the GitHub body
and file synchronized. Never backdate a later fix into an earlier release.

## Обновление старых Windows-клиентов

Переход `0.8.0 → v0.8.1 → client-v0.9.0` уже выполнен.
[Исторический план и ограничения bridge](archive/CLIENT-BRIDGE-0.8.1.md) сохранены
для сопровождения старых установок; не повторяйте публикацию этих тегов.
Bridge commit `3747a0d` нужен для воспроизводимости старых выпусков: сохраняйте его
доступность. Истечение подписанного bridge-манифеста может потребовать ручной
установки актуального клиента; старые assets не заменяются.

Manager 0.4.0 опубликован отдельно от Client 0.11.0; новый Windows UI и полный installer
доставляются Manager-тегом, не Client-тегом. [Контракт desktop и обновлений](MANAGER-DESKTOP.md).

## CI и публикация

`.github/workflows/check.yml` проверяет ветки/PR и вызывается release workflow.
Он не публикует серверные образы. `.github/workflows/release.yml` выбирает **ровно
один** компонент по тегу через `scripts/release-contract.mjs`, проверяет его версию,
запускает проверки и только затем публикует свои артефакты.

Release workflow передаёт выбранный компонент в reusable `check.yml`. Ветки и PR
по умолчанию используют `all`; ручной `workflow_dispatch` позволяет проверить
`all`, `client`, `server` или `manager` без публикации.
Повторные push/PR-проверки одной ветки и scope отменяют устаревший запуск;
разные компоненты и ручные проверки имеют отдельные concurrency groups.

| Scope | Выпускные сборки и загружаемые CI artifacts | Зависимости интеграционных тестов |
|---|---|---|
| `client` | Только Client EXE, лицензии, checksum и подписанный манифест при tag push | Опубликованный подписанный Server; встроенный сервер из общего `server/` |
| `server` | Только Server ZIP; release job публикует Linux image и манифест | Минимальный Manager host/runtime без NSIS-установщика; полный серверный lifecycle |
| `manager` | Только Manager EXE; release job собирает bundle и подписывает metadata | Опубликованный подписанный Server ZIP/image, без пересборки Server; SCM/EXE и Compose lifecycle |
| `all` | Все три пакета | Полные исходники и полный набор проверок ветки/PR |

Windows artifacts разделены: `pawtalk-windows`, `pawtalk-server-windows` и
`pawtalk-manager-windows`. Каждый publisher скачивает только свой artifact в
соответствующий каталог. Зависимости тестов не загружаются как чужие release assets.
Server dependency выбирается по подписанному опубликованному манифесту и digest,
а не по потенциально ещё не выпущенному `server/VERSION` из дерева Manager/Client.
Подмена ZIP, неверный hash/size или отсутствие доверенного Server прерывают проверку.
Уже опубликованные теги и их workflow не изменяются.

- Client tag публикует только клиентские assets.
- Server tag публикует GHCR image, Windows Server ZIP и server metadata; клиентский установщик не публикуется.
- Manager tag публикует общий bundle, Windows EXE и metadata; пустого фиктивного релиза нет.
- Shared/API изменения проверяют обе стороны. Подписи используют отдельные ключи.
- Опубликованный release/image version повторно не используется. Ошибка публикации
  после загрузки образа требует отдельного разбора; не перезаписывать image/tag.
- Канал каждой линии задаётся независимо repository variable `PAWTALK_CLIENT_CHANNEL`,
  `PAWTALK_SERVER_CHANNEL`, `PAWTALK_MANAGER_CHANNEL`: `stable` или `preview` (default).
  SemVer prerelease всегда принудительно `preview`. Workflow передаёт один и тот же
  выбор в signing и GitHub Release flags; stable Client получает отметку Latest,
  Server/Manager её не перехватывают. Updater всё равно не использует общий Latest.

Updater каждого компонента просматривает список Releases с пагинацией и фильтрует
своё семейство, SemVer, draft, подпись и ассеты. Client дополнительно учитывает
выбранный канал; Server/Manager выбирают последнюю версию без настройки канала,
включая prerelease. Поле channel в подписанном schema 1 манифесте сохраняется
для проверки соответствия отметке GitHub Release. Не использовать общий
`/releases/latest`: он не представляет три независимые линии.

## Ключи и доверие

Client сохраняет `electron/update-keys.json` и существующий Ed25519 private key
в GitHub secret `PAWTALK_UPDATE_PRIVATE_KEY` ([Client signing](UPDATE-SIGNING.md)).
Не менять его при bridge-переходе. Schema 1 дополнена `component: client`, понятна bridge.

Server/Manager публичные ключи внесены в `manager/trust.json` под
соответствующими разделами `server`/`manager` (key IDs `server-2026-11` и
`manager-2026-11`). Private keys создаются и хранятся **вне репозитория**, независимо, и попадают
только в secrets `PAWTALK_SERVER_PRIVATE_KEY` и `PAWTALK_MANAGER_PRIVATE_KEY`.
Не сохранять приватные ключи, токены или реальные приглашения в Git/CI artifacts.
Проверка Server key выполняется до публикации GHCR image.

Envelope: `keyId`, Base64 `payload`, Ed25519 `signature` над точными байтами payload.
Server/Manager schema 1 содержит `component`, `repository`, `version`, `channel`,
`publishedAt`/`expiresAt` (Unix seconds), `apiProtocol:1`, `dataSchema:1`.
Server добавляет фиксированное имя GHCR image и immutable digest, а также
`windows: {name, sha256, size}` для точного Windows ZIP. Manager добавляет
точное имя bundle, SHA-256, размер, `launcherProtocol:1`, `configSchema:1` и
`windowsInstaller: {name, sha256, size}` для точного EXE.
Манифест другого типа/ключа, просроченный или с неподдерживаемой схемой отклоняется.
Один checksum из той же загрузки не является trust root.

Trust root bootstrap — проверенный checkout с известными публичными ключами,
не ключ из непроверенного скачанного bundle. Добавлять новые Server/Manager ключи
можно через bundle, подписанный текущим Manager ключом; существующие корни должны
сохраняться без изменений. Удаление/замена корней и обновление стабильного launcher
сейчас требуют явного административного обслуживания. Сначала доставить новый
публичный ключ, затем переключать подпись; не удалять единственный доверенный ключ
из уже установленных клиентов/агентов.

Хост, пропустивший доставку нового публичного ключа, после переключения подписи
останется заблокированным. Для него нужен явный переходный Manager bundle,
подписанный ещё доверенным старым ключом, через `manager now --manifest ... --bundle ...`;
затем обычное обновление. Автоматического принятия неизвестного ключа нет.

`scripts/release-metadata.mjs` собирает/подписывает свои артефакты без публикации.
Для Server нужен точный `PAWTALK_IMAGE_DIGEST` и Windows ZIP из verification job;
для Manager нужен Windows EXE из той же проверки и собирается allowlist
полного кода, Compose, units, trust и notices. `--check-key` только проверяет ключ.

## Совместимость и встроенный сервер

API protocol 1 независим от release versions; отсутствие поля означает legacy
protocol 1. [Матрица](COMPATIBILITY.md). Breaking API/schema требуют server-first
перехода с обратной совместимостью либо отдельного согласованного механизма восстановления.

Текущие сборки Client и Windows Server используют один `server/` через
`scripts/server-core.mjs`, один Go toolchain и одинаковые флаги. Источники версий:
`server/VERSION` и `server/standalone.Dockerfile` (Go/LiveKit). Receipt
`resources/server/bundled-server.json` содержит SHA-256 исходников и бинарников.
При совместной сборке `node scripts/check-server-core.mjs` требует побайтового
совпадения Go/LiveKit в обоих пакетах. Смена ядра доставляется установленным
клиентам только новым Client-релизом; выпуск Server сам по себе Client не меняет.
[Контракт и проверки](BUNDLED-SERVER.md).

## Проверки перед разрешённым push/release

1. Проверить diff/staged content и `npm run check:public`.
2. Прогнать затронутые шаги `.github/workflows/check.yml` на финальном дереве:
   Client build/unit/native/Electron/UI, Go tests+vet/race на подходящей платформе,
   Docker lifecycle и Compose integration, Python fault/signing tests.
3. После сборки NSIS выполнить `node scripts/packaged-smoke.mjs`; хэшировать именно
   тот EXE, который будет загружен. Для сайта — `node scripts/check-website.mjs`.
4. Зафиксировать локально недоступные проверки: native Linux/arm64, внешний VPS/UDP,
   настоящие микрофоны/две сети. Контейнерные synthetic tests не доказывают их успех.
5. Проверить Client-only/Server-only/Manager-only маршруты, подмену metadata/assets,
   каналы, backup/restore, нездоровый rollout, SIGKILL recovery, Manager fallback.
6. Получить отдельное разрешение на публикацию.

Client, Server и Manager выпускаются независимо. Изменения общего API требуют
проверки обеих сторон и совместимого server-first перехода по [матрице](COMPATIBILITY.md).
После push различать branch CI и tag CI; передать владельцу URL **tag workflow**,
если требуется мониторинг. Локальный успех не гарантирует GitHub CI.

Client assets: `PawTalk.Setup.X.Y.Z.exe`, `update-manifest.json`, `SHA256SUMS.txt`,
один `PawTalk.Licenses.X.Y.Z.zip` с `LICENSE`, `THIRD_PARTY_NOTICES.md`, `licenses/`.
Не прикладывать отдельные лицензии или дубликат source archive; GitHub оставляет
автоматические Source code ZIP/TAR. Все источники и сторонние notices сохраняются.
README/site должны ссылаться на фактическую **клиентскую** загрузку, Server/Manager
указываются отдельно. Текущие ссылки: Client 0.11.0, Server 0.10.1 и Manager 0.3.0.
Для следующего выпуска сохранять их до фактической публикации новых assets.
Не публиковать сайт обычным push/tag.

## English

Client, Server and Manager have independent version sources and `client-v*`,
`server-v*`, `manager-v*` tags. The final legacy bridge is Client-only `v0.8.1`
from commit `3747a0d`; the migration to `client-v0.9.0` is complete.
The [historical plan](archive/CLIENT-BRIDGE-0.8.1.md) records legacy limitations;
do not repeat its publication steps. Preserve the bridge source commit for bundled
historical self-host builds. An expired bridge manifest may require manual Client installation.
Never replace historical tags or assets. The component release workflow validates
its own source, runs verification and publishes only its component's assets.
Stable/preview flags must match signed metadata. Client 0.11.0, Server 0.10.1 and
Manager 0.3.0 are published previews. Keep their links until later assets actually
exist. After accepting the Server release, independent Manager and Client tags may
run in parallel from the same verified commit; each retains its own verification
and artifacts. Branch CI alone does not authorize merging or publishing component tags.

Release verification receives the selected component scope; branch/PR checks
default to `all`. Client tags package only the Client, Server tags package only
the Server, and Manager tags package only the Manager. Windows artifacts and
publisher extraction paths are separate. Integration tests retain required test
hosts or use a published signed Server ZIP/image by immutable digest instead of
rebuilding another component. Missing trusted releases and corrupt downloads fail
closed. Manual component verification does not publish; historical tags remain
immutable.

Client retains its existing key; Server and Manager have separate provisioned
Ed25519 roots and CI secrets. Empty roots fail closed. Bootstrap trusts a reviewed
checkout; updates verify type, repository, version, channel, signature and digest.
Development builds share one server/ core across hosting modes and record source
and binary hashes. Windows Client/Server binaries must match byte for byte.
Historical Client 0.10.1 retains its pinned core; Client 0.11.0 ships the shared core.
Run applicable CI locally and packaged smoke before release; distinguish Docker,
synthetic audio and emulation from native arm64, real devices and external networks.
