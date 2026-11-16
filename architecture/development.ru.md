# Разработка и сборка

[English](development.en.md) · [Индекс](README.ru.md)

Работающий код из `main` **не доказывает** доступность функции в опубликованном теге. Перед изменениями прочитайте [AGENTS.md](../AGENTS.md) и [правила агентов](../agents/README.md). Работайте в отдельной ветке, без прямого push в `main`. Для сборки Desktop нужны **Windows x64**, Node.js 24.22.1+, Go 1.27.3+ и Visual Studio Build Tools с C++/Windows SDK. `PAWTALK_GO` может указывать на исполняемый Go.

~~~powershell
npm ci
npm run native:build
npm run dev
~~~

Зоны ответственности: Client [React/TypeScript](../src/), [Electron](../electron/); общее ядро Server [Go](../server/); Windows Manager [Go controller](../manager/windows/) и [Electron UI](../manager/desktop/); Linux Manager [Python](../manager/pawtalk_manager/). Сетевое поведение проверяется контрактными, релизными и security-тестами, а не только локальным GUI.

Доступные проверки находятся в [package scripts](../package.json), [Go tests](../server/) и [CI](../.github/workflows/check.yml). Выбирайте тесты по затронутым компонентам и [правилам](../agents/testing/README.md). Не коммитьте сгенерированные assets, закрытые ключи, ссылки входа, локальные backup и отчёты диагностики.

**Важно:** актуальный исходный код и исторические harnesses могут отличаться от опубликованных бинарников API 2. Пользовательские документы сверяйте с неизменяемыми релизами/asset, а не только с новым `main`.
