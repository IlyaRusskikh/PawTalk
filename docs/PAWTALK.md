# PawTalk transition / Переход на PawTalk

PawTalk uses new identifiers throughout the app and server. Published Voicecord
releases, their actual filenames and historical changelog entries retain their
original names. No published release is replaced.

PawTalk использует новые идентификаторы в клиенте и сервере. Старые выпуски,
имена опубликованных файлов и история изменений сохраняют исходное название.

## Fresh installation / Новая установка

- Exit and uninstall Voicecord; disable its old startup entry if necessary.
  Install PawTalk with a new profile. Old data is not imported or deleted.
- Update all clients and servers together. Create new `pawtalk://` invitations;
  old links, clients, data topics and encryption contexts are not supported.
- Recreate configuration using `PAWTALK_*` examples and use a new server data
  volume. Preserve any needed old data separately. Images and systemd units use
  `pawtalk` names.

Удалите Voicecord и установите PawTalk с новым профилем. Обновите всех участников
и серверы вместе, пересоздайте приглашения, конфигурацию `PAWTALK_*` и том данных.
Прежние данные автоматически не импортируются и не удаляются.

## Publication sequence / Порядок публикации

1. Approved CC0 recordings are integrated in `public/sounds/`: entry is variant B
   (Meow Cat #13), exit is variant A (Meow Cat #2), and five message purrs use the
   v2 fades (120/240 ms). All recordings are by Joseph SARDIN / BigSoundBank.
   `sources.json` records provenance, license and checksums. Earlier generated
   and user-provided meows are not application assets.
2. Run `npm run build`, `npm run test:sounds`, `npm test` and relevant voice/chat
   integration checks. The sound smoke verifies visibility, own/history/replay/
   reconnect suppression, cooldown, five purr variations, mute/volume settings,
   native sink-error handling and file-based packaged asset loading. It uses
   synthetic chat transport; real audio devices and separate networks still
   need manual verification.
3. Rename `IlyaRusskikh/voicecord` to `IlyaRusskikh/pawtalk` and point `origin`
   at `https://github.com/IlyaRusskikh/PawTalk.git`. This migration is complete;
   the old 0.5.2 release remains available under the renamed repository.
4. Configure `PAWTALK_UPDATE_PRIVATE_KEY` in GitHub Actions with the existing
   Ed25519 key. The public key is unchanged and its identifier is `pawtalk-2026`.
   The secret is configured. Keep the private key outside the repository.
5. For a release, bump the version per `RELEASING.md`, update the examples,
   READMEs, first-call guide and both landing pages, then run the checks and
   review the full diff. New Windows installers use `PawTalk.Setup.X.Y.Z.exe`.
6. Push the version commit and a new annotated tag. After tag CI succeeds,
   publish the four verified release assets and notes. Confirm the GHCR image is
   public, then deploy Pages separately and verify English and Russian URLs.
   Never replace an existing release, tag or installer.

Сначала согласуйте и подключите звуки, выполните проверки и создайте коммит.
Репозиторий переименован, `origin` указывает на `IlyaRusskikh/PawTalk`, а секрет
`PAWTALK_UPDATE_PRIVATE_KEY` настроен. Для выпуска назначьте новую версию,
обновите документацию и сайт, проверьте diff и CI, затем отправьте новый тег.
После зелёного CI опубликуйте ассеты релиза, проверьте публичный GHCR-образ
и отдельно разверните Pages.
Подпись проекта в Codex и локальный путь checkout не входят в коммит; при переносе
checkout учитывайте существующие Git worktree.
