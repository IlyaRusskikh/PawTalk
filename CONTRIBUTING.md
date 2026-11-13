# Contributing / Участие в разработке

## English

Start with [README.md](README.md). Fork the repository, create a branch, make a
focused change and open a pull request describing the problem, the resulting
behavior and how you checked it. Add or update tests when behavior changes.
Keep both root READMEs current when changing setup or user-facing features.
Contributions are made under the project's `AGPL-3.0-only` license.

Use [AGENTS.md](AGENTS.md) and [verification routing](agents/testing/README.md)
for affected checks before pushing. Open a focused PR from current main; squash
merge requires successful PR CI and explicit owner approval. Report unavailable
checks. Do not watch CI unless asked.

Never include room passwords, invitations, E2EE keys, TLS private keys, personal
recordings, local diagnostics or `manager/generated/`. Replace real addresses
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

Следуйте [AGENTS.md](AGENTS.md) и [маршрутизации проверок](agents/testing/README.md)
перед push. Ветка — от актуального main; squash merge требует успешного PR CI и
отдельного разрешения владельца. Укажите недоступные проверки. Не отслеживайте CI
без поручения.

Не добавляйте пароли комнат, приглашения, ключи E2EE, приватные TLS-ключи,
личные записи, локальные отчёты и `manager/generated/`. Реальные адреса заменяйте
примерами. Перед коммитом просматривайте `git diff --cached`. Уязвимости сообщайте
через private vulnerability reporting GitHub, если он включён; не публикуйте
секреты в открытом issue.
Порядок выпусков: [docs/RELEASING.md](docs/RELEASING.md).
