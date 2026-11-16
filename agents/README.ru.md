# Индекс знаний агентов

[English](README.md) · [Правила входа](../AGENTS.ru.md)

Сначала прочитайте [AGENTS.md](../AGENTS.md). Далее загружайте только материалы, относящиеся к текущей задаче. Исходники и исполняемые контракты важнее устаревших описаний.

| Задача | Контекст | Навык |
| --- | --- | --- |
| Где расположен компонент и его зависимости | [Карта компонентов](architecture/components.md) | — |
| Любая правка, ветка или PR | [Правила разработки](rules/development.md), [маршрутизация тестов](testing/README.md) | [pawtalk-verify](../.agents/skills/pawtalk-verify/SKILL.md) |
| API, хранилище, общее ядро, обновлятор | [Совместимость](../docs/server/compatibility.ru.md), [инварианты](architecture/invariants.md) | [pawtalk-compat](../.agents/skills/pawtalk-compat/SKILL.md) |
| Авторизация, шифрование, загрузки, границы доверия | [Безопасность](../SECURITY.ru.md), [инварианты](architecture/invariants.md) | [pawtalk-security](../.agents/skills/pawtalk-security/SKILL.md) |
| Подготовка и публикация выпуска | [Релизный процесс](../architecture/releasing.ru.md), [настройка GitHub](rules/github.md) | [pawtalk-release](../.agents/skills/pawtalk-release/SKILL.md) |
| Инфраструктура агентов/CI/каталога | [Решение 001](decisions/001-agent-and-release-infrastructure.md), [официальные источники](rules/tooling.md) | pawtalk-verify |

Пользовательские и операторские инструкции находятся в [docs/](../docs/README.ru.md). Исторические проверки подтверждают лишь датированное состояние, а не текущую готовность. Доступные пользователям версии определяют GitHub Releases, а исходные манифесты описывают дерево разработки.

Codex автоматически обнаруживает `.agents/skills/`. Claude Code импортирует `AGENTS.md` через `CLAUDE.md`, Gemini CLI — через `GEMINI.md`. У Cursor и Copilot короткие собственные точки входа. Адаптеры разделяют правила, но не гарантируют одинаковые полномочия или автоматическое обнаружение навыков. В среде без автоматического discovery изучайте соответствующий `SKILL.md` непосредственно; копии и символические ссылки базы знаний не требуются.
