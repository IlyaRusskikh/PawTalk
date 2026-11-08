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
3. Run checks, review the complete diff and create the transition commit.
4. Rename `IlyaRusskikh/voicecord` to `IlyaRusskikh/pawtalk`, then run
   `git remote set-url origin https://github.com/IlyaRusskikh/pawtalk.git`, verify
   remote access and push. Do not reuse the old repository name.
5. Before a release tag, configure the GitHub Actions secret
   `PAWTALK_UPDATE_PRIVATE_KEY` with the existing Ed25519 signing key. The public
   key is unchanged; its identifier is now `pawtalk-2026`. Bump the version per
   `RELEASING.md`; never reuse a tag. New installers use `PawTalk.Setup.X.Y.Z.exe`.
6. Publish the new GHCR image, check public access, and update download links to
   the actual new release. Deploy Pages separately and verify `/pawtalk/` and
   locale links. Existing 0.5.2 links retain `Voicecord.Setup.0.5.2.exe`.

Сначала согласуйте и подключите звуки, выполните проверки и создайте коммит.
Затем переименуйте репозиторий, смените `origin`, проверьте доступ и выполните push.
Перед выпуском создайте секрет `PAWTALK_UPDATE_PRIVATE_KEY` с прежним ключом и
назначьте новую версию. Сайт, GHCR и ссылки загрузки обновляются отдельно.
Подпись проекта в Codex и локальный путь checkout не входят в коммит; при переносе
checkout учитывайте существующие Git worktree.
