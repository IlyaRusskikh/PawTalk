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
явно описываются в CHANGELOG. Первую версию **0.1.0** уже установили — перед первым
релизом увеличивать её не нужно. Не меняйте версию на каждый рабочий коммит.

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
   git tag -a v0.1.0 -m "Voicecord 0.1.0"
   git push origin main
   git push origin v0.1.0
   ```

6. Дождитесь успешного GitHub Actions для этого тега, включая **Publish server
   image to GHCR**. Серверный образ получает теги `X.Y.Z` и `sha-<commit>`;
   публикация выполняется только после успешных server и windows jobs.
   Server jobs включают нативные amd64/arm64-проверки, а тег образа содержит
   общий manifest `linux/amd64,linux/arm64`.
   При первом выпуске сделайте пакет публичным по [SERVER.md](SERVER.md).
   Скачайте artifact
   `voicecord-windows`: в нём установщик, его SHA-256 и копии лицензий.
   Откройте **Releases → Draft a new release**, выберите существующий тег,
   перенесите описание из CHANGELOG и приложите файлы из artifact. Укажите команду
   `docker pull ghcr.io/ilyarusskikh/voicecord-server:X.Y.Z`, ссылку на исходный
   тег и digest образа из Summary. Обновите пример версии в `.env.server.example`
   перед выпуском, чтобы шаблон ссылался на этот же образ.
7. Рядом с установщиком укажите, что соответствующие исходники доступны в этом
   же релизе (**Source code**, точный тег) и что проект под `AGPL-3.0-only`.
   Для распространяемых встроенных бинарников также сохраните ссылки на их
   исходники и лицензии из `THIRD_PARTY_NOTICES.md`.
   Если выпуск экспериментальный, отметьте **pre-release**. Проверьте описание
   и только затем публикуйте релиз.

Не перезаписывайте опубликованные теги и установщики. Исправление уже выпущенной
версии получает новый номер. Полный `release/` не загружается в Git или GitHub:
там могут быть локальные отчёты и записи; прикладываются только проверенные файлы.
SSH нужен для Git push, а не для сборки. GitHub Desktop также может работать через HTTPS.

## English

Versions use **X.Y.Z**: small fixes increment Z (`patch`), substantial changes Y
(`minor`), and major product/architecture changes X (`major`). Incrementing a
component resets all components to its right. This is a project change-size
policy, not a strict compatibility guarantee. Initial version: **0.1.0**.

Use `npm version patch|minor|major --no-git-tag-version --ignore-scripts`
(choose one keyword) to update both manifests. Update CHANGELOG and both READMEs,
run the checks above, build and smoke-test the installer, then commit and create
an annotated `vX.Y.Z` tag. Push the branch and the tag. CI validates tag/version
consistency and uploads `voicecord-windows`. After both test jobs pass, a tag push
also publishes `ghcr.io/<owner>/<repo>-server:X.Y.Z` and `:sha-<commit>` for
Linux amd64 and arm64 under one multi-platform manifest. Server lifecycle checks
run on native runners for both architectures. Make the GHCR package public once,
and include its digest and source
tag in release notes. Update `.env.server.example` to match each release.
Publishing the GitHub Release itself is manual.

After CI passes, draft a GitHub Release for the exact tag, attach the installer,
SHA-256 and license files, and include changes, limitations and a clear link to
the corresponding source at that tag. Preserve third-party source/license links.
Review and publish. Never replace a released tag or binary; issue a new version.
Do not upload local QA reports, recordings or an entire `release/` directory.
