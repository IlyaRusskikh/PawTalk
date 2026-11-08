# Versions and releases / Версии и релизы

## Русский

Версия имеет вид **X.Y.Z**. Это принятая в проекте шкала размера изменений:

| Изменение | Команда | Пример |
| --- | --- | --- |
| Исправление или небольшое улучшение | `npm version patch --no-git-tag-version --ignore-scripts` | `0.1.0 → 0.1.1` |
| Значительная функция или переработка | `npm version minor --no-git-tag-version --ignore-scripts` | `0.1.7 → 0.2.0` |
| Очень крупное изменение продукта или архитектуры | `npm version major --no-git-tag-version --ignore-scripts` | `0.8.4 → 1.0.0` |

При увеличении старшего разряда младшие обнуляются. Это не обещание полной
совместимости по SemVer: до 1.0 проект экспериментальный, несовместимости
явно описываются в CHANGELOG. Первая версия **0.1.0** уже опубликована как
предварительный выпуск. Не меняйте версию на каждый рабочий коммит.

1. Внесите изменения, обновите подходящие тесты и оба README, запишите результат
   в `CHANGELOG.md` в раздел Unreleased.
2. Для следующего выпуска выполните одну из команд выше. Она обновляет
   `package.json` и `package-lock.json`, не создавая коммит или тег.
3. Перенесите Unreleased в раздел новой версии, добавьте фактическую дату выпуска.
4. Выполните `npm run build`, `npm test`, `npm run check:public`,
   `go test ./...` и `go vet ./...` в `server`. На Windows выполните
   `.\build.cmd -InstallDependencies` и `node scripts/packaged-smoke.mjs`.
   Для звука/сети выполните подходящие проверки из `ACCEPTANCE.md` и укажите
   непроверенные сценарии. Сборка должна быть из тех же исходников, что и тег.
5. Проверьте `git diff` и `git diff --cached`. Создайте коммит, например
   `Release 0.1.0`, затем аннотированный тег (подставьте текущую версию):

   ```sh
   git tag -a v0.1.0 -m "PawTalk 0.1.0"
   git push origin main
   git push origin v0.1.0
   ```

6. Дождитесь успешного GitHub Actions для этого тега, включая **Publish server
   image to GHCR**. Серверный образ получает теги `X.Y.Z` и `sha-<commit>`;
   публикация выполняется только после успешных server и windows jobs.
   Server jobs включают нативные amd64/arm64-проверки, а тег образа содержит
   общий manifest `linux/amd64,linux/arm64`.
   При первом выпуске сделайте пакет публичным по разделу
   [«Первая публикация образа»](#первая-публикация-образа-для-владельца-репозитория).
   Скачайте artifact
   `pawtalk-windows`: в нём установщик, его SHA-256, подписанный манифест и один архив лицензий. До tag push настройте signing secret по [UPDATE-SIGNING.md](UPDATE-SIGNING.md).
   Откройте **Releases → Draft a new release**, выберите существующий тег,
   перенесите описание из CHANGELOG и приложите файлы из artifact. Укажите команду
   `docker pull ghcr.io/ilyarusskikh/pawtalk-server:X.Y.Z`, ссылку на исходный
   тег и digest образа из Summary. Обновите пример версии в `.env.server.example`
   перед выпуском, чтобы шаблон ссылался на этот же образ.
7. Обновите в обоих README версию, прямую ссылку на фактическое имя установщика
   в assets и ссылку на описание релиза. Для pre-release используйте ссылку
   на конкретный тег: `/releases/latest` не выбирает предварительные выпуски.
   Обновите также обе страницы в `website/` и `docs/FIRST-CALL.ru.md`.
   Для сайта выполните `node scripts/check-website.mjs`; ручная публикация
   описана в `website/README.md` и не запускается обычным push или тегом.
   Рядом с установщиком укажите, что соответствующие исходники доступны в этом
   же релизе (**Source code**, точный тег) и что проект под `AGPL-3.0-only`.
   Для распространяемых встроенных бинарников также сохраните ссылки на их
   исходники и лицензии из `THIRD_PARTY_NOTICES.md`.
   Если выпуск экспериментальный, отметьте **pre-release**. Проверьте описание
   и только затем публикуйте релиз.

Не перезаписывайте опубликованные теги и установщики. Исправление уже выпущенной
версии получает новый номер. Полный `release/` не загружается в Git или GitHub:
там могут быть локальные отчёты и записи; прикладываются только проверенные файлы.
SSH нужен для Git push, а не для сборки. GitHub Desktop также может работать через HTTPS.

### Шаблон ассетов

В каждом новом релизе прикрепляйте четыре основных файла:

- `PawTalk.Setup.X.Y.Z.exe` — установщик Windows x64;
- `update-manifest.json` — подписанный Ed25519 манифест этой сборки; [настройка ключа и подписи](UPDATE-SIGNING.md);
- `SHA256SUMS.txt` — SHA-256 именно загруженного EXE (можно также указать ZIP);
- `PawTalk.Licenses.X.Y.Z.zip` — `LICENSE`, `THIRD_PARTY_NOTICES.md` и
  папка `licenses/` из той же версии/сборки.

Не прикрепляйте лицензии по одному и не дублируйте исходники отдельным ассетом:
GitHub автоматически добавляет **Source code (zip)** и **Source code (tar.gz)**
для точного тега. В описании релиза должны быть ссылки на этот тег и архив лицензий.

При упорядочивании старого релиза сначала проверьте содержимое ZIP и хэши,
затем удаляйте только избыточные ассеты. Сохраняйте EXE и тег без изменений.
Если переименован архив или удалён дубликат исходников, обновите имена в
`SHA256SUMS.txt` и ссылки в описании. Готовый архив с правильным содержимым
можно переименовать через метаданные GitHub, сохраняя его байты и digest.

### Первая публикация образа для владельца репозитория

Workflow `.github/workflows/check.yml` публикует образ после push тега `vX.Y.Z`,
**только если прошли проверки server и windows**. Серверные Go/Docker lifecycle
проверки выполняются на нативных amd64- и arm64-раннерах. Buildx/QEMU собирает
оба варианта в общий multi-platform manifest. Номер тега должен совпадать
с `package.json` и `package-lock.json`. Обычный push в `main` только проверяет
проект; образ не публикуется.

1. Отправьте коммит с workflow и этими файлами на GitHub. Для первого выпуска
   создайте и отправьте `v0.1.0` по порядку выпуска выше.
2. Дождитесь зелёного **Verify and package → Publish server image to GHCR**.
   В Summary появятся имя, версия и digest образа. Для публикации используется
   `GITHUB_TOKEN` с `packages: write`; личный PAT в Secrets не нужен.
3. Откройте профиль GitHub → **Packages → pawtalk-server → Package settings**.
   В разделе видимости выберите **Change visibility → Public** и подтвердите.
   Публичность репозитория сама по себе не делает новый пакет публичным.
4. Проверьте скачивание на машине без GitHub-логина:
   `docker pull ghcr.io/ilyarusskikh/pawtalk-server:0.1.0`.
   После этого инструкция для VPS готова к использованию без авторизации.

Проверьте общий manifest командой
`docker buildx imagetools inspect ghcr.io/ilyarusskikh/pawtalk-server:0.1.0`:
в нём должны присутствовать `linux/amd64` и `linux/arm64`.

При форке имя образа вычисляется из `<владелец>/<репозиторий>-server` в нижнем
регистре; обновите `PAWTALK_IMAGE` и ссылки скачивания под свой fork.
Не заменяйте уже опубликованный тег версии; выпускайте новый номер.
Механизм публикации и видимости описан в [документации GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## English

Versions use **X.Y.Z**: small fixes increment Z (`patch`), substantial changes Y
(`minor`), and major product/architecture changes X (`major`). Incrementing a
component resets all components to its right. This is a project change-size
policy, not a strict compatibility guarantee. Initial version: **0.1.0**.

Use `npm version patch|minor|major --no-git-tag-version --ignore-scripts`
(choose one keyword) to update both manifests. Update CHANGELOG and both READMEs,
run the checks above, build and smoke-test the installer, then commit and create
an annotated `vX.Y.Z` tag. Push the branch and the tag. CI validates tag/version
consistency and uploads `pawtalk-windows`. After both test jobs pass, a tag push
also publishes `ghcr.io/<owner>/<repo>-server:X.Y.Z` and `:sha-<commit>` for
Linux amd64 and arm64 under one multi-platform manifest. Server lifecycle checks
run on native runners for both architectures. Make the GHCR package public once,
and include its digest and source
tag in release notes. Update `.env.server.example` to match each release.
Publishing the GitHub Release itself is manual.

After CI passes, draft a GitHub Release for the exact tag, attach the installer,
SHA-256 and license files, and include changes, limitations and a clear link to
the corresponding source at that tag. Preserve third-party source/license links.
Update the version, actual installer asset URL and release-notes link in both
READMEs. Link to the exact tag for previews; `/releases/latest` excludes pre-releases.
Also update both `website/` pages and `docs/FIRST-CALL.ru.md`, and run
`node scripts/check-website.mjs`. Website publishing is manual; see `website/README.md`.
Review and publish. Never replace a released tag or binary; issue a new version.
Do not upload local QA reports, recordings or an entire `release/` directory.

Use exactly four primary assets: signed `update-manifest.json` ([key setup](UPDATE-SIGNING.md)), `PawTalk.Setup.X.Y.Z.exe`,
`SHA256SUMS.txt` for the exact uploaded installer, and
`PawTalk.Licenses.X.Y.Z.zip` containing `LICENSE`, `THIRD_PARTY_NOTICES.md`
and `licenses/` from the same release/build. Do not attach licenses separately
or upload a duplicate source archive; GitHub supplies Source code ZIP/TAR for
the tag automatically. Link the tag and license ZIP in the release description.
When tidying an older release, verify archive contents before removing redundant
files, preserve the installer/tag, and update affected checksum filenames/links.
An existing correct ZIP can be renamed in GitHub metadata without replacing its bytes.
