# Contributing / Участие в разработке

## English

Start with [README.md](README.md). Fork the repository, create a branch, make a
focused change and open a pull request describing the problem, the resulting
behavior and how you checked it. Add or update tests when behavior changes.
Keep both root READMEs current when changing setup or user-facing features.
Contributions are made under the project's `AGPL-3.0-only` license.

Before a pull request, run `npm run build`, `npm test`, `npm run check:public`,
and `go test ./...` / `go vet ./...` inside `server`. For desktop/audio changes,
also run `npm run smoke` and the relevant integration or hardware checks in
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md). Describe checks you could not run.

Never include room passwords, invitations, E2EE keys, TLS private keys, personal
recordings, local diagnostics or `deploy/generated/`. Replace real addresses
with documentation examples. Inspect `git diff --cached` before committing.
For a suspected security issue, use GitHub's private vulnerability reporting
if enabled; never post credentials in a public issue.
Release steps are in [docs/RELEASING.md](docs/RELEASING.md).

## Русский

Начните с [README.ru.md](README.ru.md). Создайте fork и отдельную ветку, внесите
изменение и откройте pull request: опишите проблему, новое поведение и проверки.
Если меняется поведение, добавьте или обновите подходящие тесты. При изменениях
запуска или возможностей обновляйте оба корневых README. Вклад в проект
предоставляется под его лицензией `AGPL-3.0-only`.

Перед pull request выполните `npm run build`, `npm test`, `npm run check:public`,
а в `server` — `go test ./...` и `go vet ./...`. Для интерфейса и звука также
запустите `npm run smoke` и подходящие интеграционные/аппаратные проверки из
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md). Укажите, что не удалось проверить.

Не добавляйте пароли комнат, приглашения, ключи E2EE, приватные TLS-ключи,
личные записи, локальные отчёты и `deploy/generated/`. Реальные адреса заменяйте
примерами. Перед коммитом просматривайте `git diff --cached`. Уязвимости сообщайте
через private vulnerability reporting GitHub, если он включён; не публикуйте
секреты в открытом issue.
Порядок выпусков: [docs/RELEASING.md](docs/RELEASING.md).
