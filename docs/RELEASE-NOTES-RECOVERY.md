# Исправление публичных описаний / Public release notes correction

## Русский

Подготовлены исправления только текста `releases/client-v0.12.1.md`,
`server-v0.11.1.md`, `manager-v0.5.1.md`. Удалены RU/EN фразы об ожидании публикации
и tag CI, включая «Описание подготовлено; публикация и tag CI ещё не выполнены»,
`Prepared notes; publication/tag verification are pending`,
`Successful tag CI will be recorded only after it completes`, а также аналогичные
оговорки в начале и конце описаний. Вместо статуса оставлено нейтральное описание:
preview, платформы и изменения относительно предыдущего опубликованного выпуска
того же компонента. Функции, исправления, совместимость, установка, ограничения,
файлы, исходники и лицензии сохранены. История неуспешных предыдущих тегов сохранена.

GitHub Releases автоматически не синхронизирует исправления файлов в main.
После отдельного разрешения владельца нужно заменить **только body** этих трёх
описаний текстом соответствующих исправленных файлов в проверенном main.
Не брать старые заметки из release tag: там остаётся исторический исходник.
Не запускать Preflight, promotion, сборку, подпись или новую публикацию.

Безопасный порядок:

1. После согласованного merge получить main в чистом checkout. Проверить SHA,
   diff заметок и `node scripts/check-release-notes.mjs client-v0.12.1 server-v0.11.1 manager-v0.5.1`.
2. Прочитать каждый Release через `gh api repos/IlyaRusskikh/PawTalk/releases/tags/<tag>`.
   Сохранить JSON вне Git, в приватном временном каталоге: ID, name, tag_name,
   target_commitish, draft/prerelease, published_at и все assets с ID/размером/digest.
   Проверить, что это существующий опубликованный выпуск нужного компонента.
3. После отдельного разрешения владельца выполнить следующие команды из этого
   checkout. Они меняют только текст; никаких upload/delete/create или флагов канала:

```powershell
gh release edit client-v0.12.1 --repo IlyaRusskikh/PawTalk --notes-file releases/client-v0.12.1.md
gh release edit server-v0.11.1 --repo IlyaRusskikh/PawTalk --notes-file releases/server-v0.11.1.md
gh release edit manager-v0.5.1 --repo IlyaRusskikh/PawTalk --notes-file releases/manager-v0.5.1.md
```

4. После каждой команды проверить exit code; при ошибке остановиться и выяснить
   состояние, не перевыпускать релиз. Повторно получить JSON и сравнить с сохранённым:
   измениться может body и служебный updated_at; ID, заголовок, тег, канал,
   published_at и assets должны сохраниться. Не изменять теги, бинарники, подписи,
   Docker images, checksums или настройки GitHub.
5. Проверить полное совпадение заголовков/версий/компонентов, текста и всех ссылок:

```powershell
node scripts/check-release-notes.mjs --published client-v0.12.1 server-v0.11.1 manager-v0.5.1
```

Это лёгкая проверка чтением API через `gh`, без пересборки и полного CI. Проверить
также отображение RU/EN в GitHub UI. Если заголовок уже неверен, отдельно согласовать
его точное исправление; body-only команды его не меняют. Запрет изменения остальных
полей и артефактов остаётся в силе.

## English

The three corrected source files remove temporary publication/tag CI statuses from
their introductions and final asset/source paragraphs. They retain neutral preview,
platform and previous-component-version descriptions instead. Features, fixes,
compatibility, installation, limitations, links and accurate failed-tag history remain.
No testing or publication success is claimed in advance.

GitHub Release bodies do not automatically follow main. After a separately approved
merge, use a clean verified main checkout, validate the three selected tags, and
save each existing public Release's API JSON outside Git in a private temporary folder.
Check its ID/title/tag/target/channel/publication date and complete asset metadata.
Obtain separate owner authorization for body-only edits, then run the three commands
above. Use corrected main files, not the historical files in the published tags.
Do not dispatch release workflows, build, sign or publish anything.

After each edit, inspect its exit status and reread the API JSON. Only body and
administrative updated_at may differ; release ID/title/tag/channel/publication date
and assets must remain unchanged. Stop on failure or mismatch; never recreate a
release or replace tags/binaries/signatures/images/checksums. Run the read-only
`--published` comparison above for exact title/tag/channel/full-body/link equality,
then inspect bilingual rendering in GitHub. A title correction, if needed, must be
reviewed separately; these body-only commands leave it unchanged.
