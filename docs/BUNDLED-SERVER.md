# Общее серверное ядро / Shared server core

Изменение в текущем дереве ещё не опубликовано. Client 0.10.1 в GitHub остаётся
на историческом Go 0.8.0 с backport; опубликованные теги и бинарники не меняются.
This development change is unreleased. Published Client 0.10.1 retains its
historical Go 0.8.0 plus backport; published tags and binaries remain unchanged.

## Источники и сборка / Source and build

Единственное ядро — [server/](../server/), один Go package. Режим selfhost запускает
временную комнату из Electron: конфигурация через stdin, временный TLS-сертификат,
SQLite в памяти, остановка при закрытии stdin. Режим serve запускает постоянную
комнату: конфигурация/SQLite/TLS на диске, службы и Manager. Авторизация, API, чат,
E2EE policy, presence и relay общие. Отдельной копии серверного ядра нет.

The only core is server/, one Go package. selfhost uses Electron/stdin lifecycle,
an ephemeral TLS certificate and in-memory SQLite. serve uses persistent config,
SQLite and TLS with service/Manager lifecycle. Auth, API, chat, E2EE policy,
presence and relay code is shared; no separate core copy is maintained.

Оба Windows-пакета собираются через [server-core.mjs](../scripts/server-core.mjs)
одним Go toolchain с одинаковыми flags/environment. Версия ядра берётся из
server/VERSION, Go/LiveKit — из server/standalone.Dockerfile, который также строит
Linux Server. Client/Server release versions остаются независимыми.

Both Windows packages use server-core.mjs with identical compiler, flags and
environment. Core version comes from server/VERSION; Go/LiveKit versions come
from server/standalone.Dockerfile, also used for Linux Server. Component release
versions remain independent.

Receipt resources/server/bundled-server.json — генерируемый файл, не source pin.
Он содержит schema 2, source, version, goVersion, livekitVersion, sourceSha256,
apiSha256 и livekitSha256. Хэш источников учитывает пути/байты Go-файлов (включая
тесты), go.mod/go.sum, VERSION и standalone.Dockerfile; build output не учитывается.
Изменение исходников во время сборки прерывает её. Generated receipt не хранится в Git.

The generated schema-2 receipt identifies source/toolchain and source/binary
hashes rather than pinning an older commit. Its source digest includes Go paths
and bytes (including tests), go.mod/go.sum, VERSION and standalone.Dockerfile;
generated build output is excluded. Source changes during compilation fail the
build. The receipt is not committed.

## Проверки / Verification

- node scripts/check-server-core.mjs сравнивает фактические Go/LiveKit-бинарники
  встроенного клиента и Windows Server ZIP побайтово через SHA-256, сверяет receipt
  с текущими исходниками. CI выполняет это при совместной сборке компонентов.
  Compares actual Client and Windows Server ZIP binaries and validates the receipt.
- node scripts/selfhost-main-smoke.mjs проверяет настоящий Electron/main/preload,
  создание комнаты, двух клиентов, TLS pin, clipboard, голос и управление громкостью,
  закрытие; RU/EN, normal/reduced motion, E2EE off/on.
  Exercises real Electron/native IPC with two synthetic-audio clients across these variants.
- node scripts/selfhost-smoke.cjs проверяет TLS/API, отказ неверному паролю,
  приватность активности, чат, E2EE policy и освобождение портов после остановки.
  Checks TLS/API/auth/activity privacy/chat/E2EE policy and listener cleanup.
- После сборки NSIS запускается node scripts/packaged-smoke.mjs: проверяет receipt,
  хэши и встроенную комнату из упакованных resources.
  Packaged smoke verifies receipt, binaries and hosting from packaged resources.

Эти синтетические проверки не заменяют два физических ПК, реальные микрофоны,
внешние сети, CGNAT, проверку UPnP/NAT-PMP у разных роутеров и нагрузочную приёмку.
Они остаются в [ACCEPTANCE.md](ACCEPTANCE.md). Для доставки исправления из общего
ядра выпускайте затронутые Client и Server; уже установленный Client не скачивает
новый Server автоматически.

Synthetic checks do not establish physical-device, external-network, router or
load acceptance. See ACCEPTANCE.md. Ship affected Client and Server releases to
deliver a shared fix; an installed Client does not automatically adopt a new Server.
