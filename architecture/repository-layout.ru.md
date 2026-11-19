# Структура репозитория

[English](repository-layout.en.md) · [Архитектура](README.md)

```text
PawTalk/
  apps/
    client/windows/     # React, Electron, native module, assets, client scripts/tests
    manager/
      windows/desktop/ # Electron UI
      windows/service/ # Go service controller
      windows/scripts/
      windows/tests/
      linux/           # Python CLI/controller and deployment templates
      tests/           # shared host/controller Python checks
      VERSION
    server/            # shared Go core; deploy/ and scripts/
    website/           # public site and its tests/scripts
  shared/              # cross-component contracts and libraries
  tooling/
    build/             # shared source staging and builds
    ci/                # validation and verification routing
    dev/               # multi-component local review
    release/           # preparation, signing, catalog and promotion
  tests/
    infrastructure/
    compatibility/
    integration/
    release/
  docs/
  architecture/
  releases/
  licenses/
  agents/
  plans/               # ignored local drafts
```

Команды разработки, проверок и упаковки запускаются из корня репозитория. Корневой package.json координирует workspace; версия Client находится в apps/client/windows/package.json и соответствующей записи package-lock. Manager и Server сохраняют независимые файлы VERSION.

Скрипты и тесты одного приложения расположены рядом с его кодом. Общие сборки, инструменты релизов и межкомпонентные тесты вынесены за apps. Одно серверное Go-ядро используется временным сервером Client и отдельным Server.

Пути исходников не определяют структуру установленных пакетов. tooling/build/manager-layout.mjs сохраняет прежнюю структуру manager/ протокола 1 в Linux-архивах и Windows bootstrap. Опубликованные архивы, пути launcher, ключи подписей, схемы API/данных и каталоги пользовательских данных независимы от этого переноса исходников.
