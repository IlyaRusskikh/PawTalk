# Независимые выпуски / Independent releases

Current public versions / Актуальные публичные версии:
[Client, Server, Manager](https://ilyarusskikh.github.io/PawTalk/downloads/).
GitHub Releases is authoritative; manifests describe source versions. Historical
notes below do not authorize repeating old publication steps.

## Approval sequence / Этапы согласования

1. Prepare a working branch from current main, component versions, CHANGELOG and
   reviewed bilingual releases/<tag>.md. Infrastructure-only PRs need no product
   version bump. Run final checks/public review, push and open PR; hand off CI URL.
   Do not monitor CI without an explicit request. Squash merge requires successful
   current PR CI and separate explicit owner permission.
2. After merge, dispatch **Release Candidate Preflight** (release.yml) on main.
   components accepts client, server, manager, a comma-separated set without spaces,
   or all. The dispatch fixes github.sha; every checkout/build uses that candidate.
   The plan checks manifests, notes, channels, unchanged main and absent tags/releases.
3. The reusable check.yml runs each selected component in its own release scope on
   Windows 2022/2025 and Ubuntu x64/ARM64; PR all is not release evidence. Common
   infrastructure runs once. Renderer, LiveKit, selfhost/room completion, SCM,
   Compose/systemd, legacy rejection, Go/API and installer smokes remain required.
4. Before any tag, prepare real Client EXE/licenses/checksum/update manifest, Server
   ZIP/multi-platform OCI archive/server manifest, Manager EXE/Linux bundle/manifest.
   Only trusted main preparation receives signing keys; PR/reusable checks receive
   none. Existing Ed25519 roots and signed payload contracts remain unchanged.
5. Seal each complete package with a receipt binding repository, exact SHA, run ID,
   run attempt, component, version, channel and every file's size/SHA-256. Upload
   immutable Actions artifacts (7-day retention). Preflight downloads the same-run
   outputs and rechecks receipts against preparation job-output digests, signatures,
   payload hashes and OCI index/platforms. Its summary reports component readiness.
   Save these original contracts and receipt digests in pawtalk-candidate-index.
   When Client+Server are selected,
   compare the separately built Go and LiveKit bytes against the Client core receipt.
6. promote defaults to false: prepare-only stops here, with no tags, Releases, GHCR
   or Pages deployment. Preferred when a successful candidate exists: dispatch
   **Promote Existing Preflight** (promote-candidate.yml) on the unchanged main SHA,
   supplying only source_run_id. It derives the complete original component set,
   versions and channels; checks GitHub API evidence and original artifacts without
   repeating check.yml, builds, signing or integration tests. The alternative remains
   a fresh release.yml dispatch with promote=true for a complete new preparation.
   Both paths separately request **release-tag**, revalidate the candidate/current
   main, precheck every tag, then create only the original selected immutable tags.
7. The owner separately approves **release-publish** for selected component jobs.
   They download and revalidate the exact prepared bytes; there is no rebuild or
   re-sign. They require matching tags and unchanged main, reject existing Releases
   and image versions, upload assets draft-first, then publish with matching channel
   flags and --latest=false. Server copies all OCI platforms with --preserve-digests
   and checks the registry digest afterward; GitHub asset digests are checked too.
8. Only actual successful publication triggers Pages regeneration from main. A
   prepare-only workflow completion cannot deploy. Manually published Releases and
   deliberate Pages workflow_dispatch remain recovery paths.

Сначала успешный Preflight на точном SHA main со всеми тестами, сборками и подписями;
только затем отдельные согласования release-tag и release-publish. Агент инициирует
нужное согласование, когда этап готов; молчание не является разрешением. Оба
Environment должны иметь Required reviewers и разрешать main, а не только теги.
[Настройки владельца](../agents/rules/github.md) выполняются вручную.

Fail closed / Отказы: failed Preflight, missing/corrupt/foreign artifact, stale main,
version/channel/input mismatch or rejected tag approval produce no tags/publication.
Publication rejection keeps already created tags unchanged. REST creation of multiple
refs is not atomic: partial tags can remain after an API failure. GHCR and Releases
are also not atomic; an orphan image, draft or a published component can remain after
later failure. Never overwrite/delete tags/assets/images or blindly rerun promotion.
Investigate, report exact completed/failed stages and prepare a new version/PR after a
failed tag/publication. A main change requires a new candidate. Artifact expiry,
workflow/signing/build-input changes or a changed source attempt invalidate reuse.
Cross-run reuse is allowed only through Promote Existing Preflight with its explicit
verified source context; never overwrite GITHUB_* or regenerate source receipts.
No external cache/server or published retry policy is
introduced. GitHub's settings and hardware/external-network acceptance are separate
from repository tests. No automated result guarantees absence of future API failures.

## Продвижение готового кандидата / Promote an existing candidate

Рекомендуемый порядок: Preflight с promote=false → успешное завершение →
Promote Existing Preflight с source_run_id → release-tag approval → независимое
release-publish approval. Повторных сборок, полной проверки CI и подписания нет.
Продвигается весь исходный набор: отдельного выбора компонентов, версий и каналов
в promotion нет. Подтверждения и запрет замены тегов/релизов остаются обязательными.
Альтернатива: Preflight с promote=true → те же два независимых подтверждения.

Preferred sequence: prepare-only Preflight → successful completion → Promote Existing
Preflight with source_run_id → tag approval → independent publication approval.
Use promote=true when a new complete preparation is wanted. Both paths share the
same protected tag/publication code in release-candidate.mjs. The promotion workflow
has actions:read and no signing secrets, PAT, build jobs or production writes before
the corresponding environment approval. Pages handles both workflow names and still
requires an actual successful publisher; prepare-only completion cannot deploy.

The source must be a completed successful main workflow_dispatch from exactly this
repository and release.yml workflow ID/path, at the same SHA as current main AND
the executing promotion checkout. API evidence includes the preflight, infrastructure,
plan/report, every selected component's complete native verification matrix and
preparation jobs; only intentionally unused jobs may be skipped. Source tag and
publisher jobs must be skipped: a failed or rejected publication is not a reusable
prepare-only candidate. Both existing tags and GitHub Releases block a new promotion.

The preflight job uploads an immutable candidate index holding the original source
run ID/attempt, component contracts and receipt hashes. The API must confirm the
index and packages belong to that run/SHA/repository, are unexpired and were created
during their successful source jobs in the SAME attempt. Jobs inherited from a prior
attempt, ambiguous names, missing artifacts and incomplete pagination are rejected.
The plan pins artifact IDs/digests and the source attempt. Each protected job fetches
the original index again and rechecks API evidence; changes invalidate promotion.
The executing promotion run has its own ID/attempt. Original receipts keep the
source IDs; they are neither regenerated nor rewritten to match the new run.

Downloads use GitHub Actions artifact REST APIs. Verify the API's SHA-256 over the
whole ZIP before parsing it; extract only an exact flat file allowlist, rejecting
duplicates, extra/missing entries, links, special/encrypted entries and traversal.
Limits: 1 MiB for the index, 8 GiB per component archive AND expanded file set; larger
candidates fail rather than fall back to a build. Storage URLs receive no GitHub
token. Then check every original receipt, file size/hash, release notes/version/channel,
signature and Server OCI index/platforms. No new production dependency is needed:
Node, standard-library Python on Ubuntu and skopeo perform integrity checks only.

Do not edit main (including workflow/config/dependencies/trust/notes), change the
selected channel variables, rerun/delete source artifacts, or submit competing release
dispatches between preparation and promotion. Both workflows share one concurrency
group. A changed main requires a fresh Preflight; timestamp/attempt ambiguity fails
closed. GitHub metadata checks and remote writes cannot be one atomic transaction:
owner coordination remains required during approvals and publication.

Older candidates without the new index are deliberately unsupported. In particular,
example run 43695001207 is not automatically reusable after this feature changes
main, and its versions may already be published. After this infrastructure is merged,
prepare a new candidate for a future release on its final main SHA. An expired index
or package, changed source attempt, rejection after tag creation, or partial writes
must not be repaired by rebuilding missing files or blindly retrying promotion.

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

### Обязательные правила / Mandatory rules

- **REL-NOTES-01:** Описание готово для конечного пользователя до merge PR. /
  Notes must be final public user documentation before PR merge.
- **REL-NOTES-02:** Запрещены временные статусы: «Ожидает публикации», «CI ещё не
  пройден», «Проверки будут выполнены», «Описание подготовлено, релиз ещё не
  опубликован», `Tag CI pending`, `Not yet published`, `Publication pending`,
  `Verification pending` и эквиваленты. / No temporary publication or CI statuses
  or equivalent wording in either language.
- **REL-NOTES-03:** Нельзя заранее заявлять об успешном CI или публикации без
  подтверждения. / Never claim successful verification or publication in advance.
- **REL-NOTES-04:** Результаты проверок находятся в GitHub Actions. Ссылка на
  успешный запуск допустима после его завершения, но необязательна в статическом
  описании. / Actions holds actual results; a confirmed successful run link is
  optional and may only be added after completion.
- **REL-NOTES-05:** Текст достоверен до/после публикации и при историческом
  просмотре. / Notes remain accurate before, after and long after publication.
- **REL-NOTES-06:** Codex проверяет одинаковую фактическую точность RU/EN. /
  Codex must review both languages for the same factual accuracy.

Пишите возможности, исправления, установку, совместимость, ограничения и точные
ссылки на файлы/исходники/лицензии, а не отчёт о ходе разработки.
Describe shipped behavior, installation, compatibility, limitations and exact
download/source/license links, rather than development progress.

PR CI и инфраструктура Preflight выполняют `node scripts/check-release-notes.mjs`
и `tests/release-notes.test.mjs`: временные статусы RU/EN, устаревшие ссылки на tag
workflows, компонент, версия, канал, платформы, разделы изменений/установки/
ограничений и ссылки. Это проверка распространённых ошибок, а не доказательство
истинности любого утверждения; ручная проверка RU/EN по REL-NOTES-03/06 обязательна.
Три снимка неудачных выпусков `client-v0.12.0`, `server-v0.11.0`, `manager-v0.5.0`
сохранены без изменений и исключены только из общего сканирования по точному SHA-256
текста. Проверка выбранного кандидата никогда не применяет это исключение.
Достоверная история предыдущих неуспешных тегов и завершённых Actions runs разрешена.

Оба пути выпуска используют общий `release-candidate.mjs`: plan проверяет описание
выбранного компонента до сборки; tag и publish повторяют проверку до записи.
`notesSha256` (UTF-8, CRLF → LF) связывает полный текст с receipt и candidate index
на точном SHA. Promote Existing Preflight сравнивает хэш с исходным планом, сохраняя
исходные run/attempt, подписи и receipts. Кандидаты без хэша заметок не продвигаются;
нужен новый Preflight на новом main.

До открытия draft проверяются его ID, заголовок, tag, канал, полный текст (включая
ссылки) и asset digests. После публикации проверки повторяются. Несовпадение
останавливает workflow без автоматической перезаписи или повторной публикации.
`node scripts/check-release-notes.mjs --published <tag>` выполняет лёгкое сравнение
опубликованного описания с файлом в проверенном checkout через авторизованный `gh`:
только чтение, без сборки или полного CI. Для отдельно согласованного исправления
трёх существующих описаний см. [безопасную синхронизацию](RELEASE-NOTES-RECOVERY.md).

PR/Preflight infrastructure runs the notes validator and tests. Both release paths
validate selected notes in shared plan/tag/publish code and bind normalized full text
through `notesSha256` in the original receipt and candidate index. Promotion preserves
source run/attempt and receipts without rebuilding/signing. Candidates without this
binding require a fresh Preflight. Draft metadata/body/links/assets are checked before
public visibility and again afterward; mismatches stop without overwriting or retrying.
`--published <tag>` compares public notes through `gh`, read-only. Exact frozen failed
drafts are exempt only from the general scan. Pattern checks do not prove all prose
true; bilingual review remains mandatory. See [recovery](RELEASE-NOTES-RECOVERY.md)
for separately approved body-only corrections, preserving historical assets.

До push тега подготовьте и проверьте `releases/<tag>.md`, например
`releases/client-v0.10.1.md`. Это полный текст GitHub Release, а не ссылка
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
   лицензия; ссылка на фактически успешный Preflight после его завершения допустима,
   но необязательна.

Не заполняйте пустые категории фразами «нет изменений» и не подменяйте заметки
ссылкой на общий changelog. Основа стиля — подробные релизы `v0.7.0`/`v0.8.0`;
готовые примеры для независимых компонентов находятся в [releases/](releases/).
Заголовок GitHub Release должен называть компонент, версию и главную тему.

Workflow проверяет полный файл заметок до сборки и публикует его через
`--notes-file`, без `--generate-notes`. После публикации проверьте отображённый текст,
ссылки и соответствие файлу; подтверждённые результаты CI можно добавить в файл и
описание после завершения выпуска. Редактирование описания не меняет теги, бинарники,
хэши, даты выпуска или stable/preview flags.

Before tagging, review a complete bilingual `releases/<tag>.md`. Lead with the
component/version and user benefit; group actual additions, fixes and changes since
the previous release of that component, omitting empty groups. Include upgrade/data/
downtime and cross-component requirements, accurate limitations, exact downloads,
verification, source/license links pinned to the tag and confirmed Preflight when available.
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

check.yml remains PR/manual/reusable verification without production signing or
publication. release.yml is dispatch-only: no tag-triggered workflow remains, so
neither GITHUB_TOKEN-created nor manually pushed tags start a second build/release.
GITHUB_TOKEN ref writes do not normally trigger another push workflow anyway.

| Scope | Release outputs | Integration dependencies |
|---|---|---|
| client | Client EXE, license ZIP, checksum; preparation signs update manifest | Shared source selfhost and current API 2 integration image |
| server | Windows ZIP; preparation builds/signs multi-platform OCI and manifest | Renderer, LiveKit, minimal Manager runtime, SCM and Compose |
| manager | Manager EXE; preparation builds Linux bundle and signs manifest | Renderer, LiveKit, current API 2 Server fixture, SCM/installer and Compose |
| all (PR only) | All Windows packages, no production signatures | Complete PR baseline, including byte equality of both shared cores |

Every selected release scope runs independently; all is never substituted for a
component-specific release mode. Some integration dependencies necessarily repeat
across component scopes, since all has different branches/fixtures. Only equivalent
infrastructure work is shared. Preparation uploads pawtalk-<component>-prepared;
publishers consume the same names from the same workflow run, verify source/run
bindings and preparation receipt digests, and cannot reach build/sign commands.
Dependencies used only as fixtures do not become another component's release assets.

Repository variables PAWTALK_CLIENT_CHANNEL, PAWTALK_SERVER_CHANNEL and
PAWTALK_MANAGER_CHANNEL independently select stable/preview (preview by default).
SemVer prerelease forces preview. Changing channel/keys/build inputs while a candidate
is awaiting review requires a new Preflight; never approve stale evidence.

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
`publishedAt`/`expiresAt` (Unix seconds), `apiProtocol:2`, `dataSchema:2`.
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
6. Получить отдельные разрешения на merge, тег и публикацию на соответствующих этапах.

Client, Server и Manager выпускаются независимо. Изменения общего API требуют
проверки обеих сторон и совместимого server-first перехода по [матрице](COMPATIBILITY.md).
После push различать branch CI и tag CI; передать владельцу URL **tag workflow**,
если требуется мониторинг. Локальный успех не гарантирует GitHub CI.

Client assets: `PawTalk.Setup.X.Y.Z.exe`, `update-manifest.json`, `SHA256SUMS.txt`,
один `PawTalk.Licenses.X.Y.Z.zip` с `LICENSE`, `THIRD_PARTY_NOTICES.md`, `licenses/`.
Не прикладывать отдельные лицензии или дубликат source archive; GitHub оставляет
автоматические Source code ZIP/TAR. Все источники и сторонние notices сохраняются.
README/site должны ссылаться на фактическую **клиентскую** загрузку, Server/Manager
указываются отдельно. Актуальные ссылки генерируются из опубликованных GitHub Releases; README и
руководства используют постоянные /downloads/#client, #server, #manager.
Не используйте /releases/latest и не меняйте ссылки коммитом после релиза.

## English

Client, Server and Manager have independent version sources and `client-v*`,
`server-v*`, `manager-v*` tags. The final legacy bridge is Client-only `v0.8.1`
from commit `3747a0d`; the migration to `client-v0.9.0` is complete.
The [historical plan](archive/CLIENT-BRIDGE-0.8.1.md) records legacy limitations;
do not repeat its publication steps. Preserve the bridge source commit for bundled
historical self-host builds. An expired bridge manifest may require manual Client installation.
Never replace historical tags or assets. The component release workflow validates
its own source, runs verification and publishes only its component's assets.
Stable/preview flags must match signed metadata. Current public versions and stable/preview channels come from GitHub Releases
and the generated downloads catalog, not version pins in this guide. After accepting the Server release, independent Manager and Client tags may
run in parallel from the same verified commit; each retains its own verification
and artifacts. Branch CI alone does not authorize merging or publishing component tags.

Release verification receives the selected component scope; PR checks
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
