# Signed client updates / Подписанные обновления

## Русский

Новые клиенты требуют `update-manifest.json` рядом с установщиком в каждом новом
релизе. Он подписан Ed25519 и связывает версию, флаг pre-release, имя файла,
размер, SHA-256 и даты выпуска/истечения. Подписываются точные байты JSON payload,
сохранённые в base64-конверте `{keyId,payload,signature}`. Формат имеет `schema: 1`.
Срок действия — 365 дней: если релиз давно не обновлялся, выпустите новую версию.
Версия с этим механизмом должна сначала попасть к пользователю обычным способом
(прежнее автообновление либо ручная установка). Уже установленные старые клиенты
и серверы не приобретают новые возможности без обновления.

Публичные ключи хранятся в `electron/update-keys.json`. Закрытый ключ не должен
попадать в Git, installer, artifact или логи. Текущий локальный ключ хранится
в `%USERPROFILE%\.codex\secrets\voicecord\update-signing.pem`, доступ ограничен
текущим пользователем Windows. Сделайте защищённую резервную копию ключа.

После `gh auth login` загрузите ключ в **Actions secret** без печати содержимого:

```powershell
$updateKey = Join-Path $env:USERPROFILE '.codex\secrets\voicecord\update-signing.pem'
Get-Content -Raw -LiteralPath $updateKey | gh secret set VOICECORD_UPDATE_PRIVATE_KEY --repo IlyaRusskikh/voicecord
```

CI подписывает только tag push, после сборки и переименования EXE. Без ключа
release job завершится ошибкой; PR и обычная сборка ключа не требуют.
В `check.yml` `VOICECORD_PRERELEASE=true` соответствует текущим предварительным
выпускам. Для стабильного релиза поменяйте значение на `false` **до создания тега**.
Флаг должен совпадать с GitHub Release, иначе клиент отклонит манифест.

Для локального подписания уже готового `release/Voicecord.Setup.X.Y.Z.exe`:

```powershell
$env:VOICECORD_UPDATE_KEY_FILE = Join-Path $env:USERPROFILE '.codex\secrets\voicecord\update-signing.pem'
$env:VOICECORD_PRERELEASE = 'true'
node scripts/sign-update.mjs
Remove-Item Env:VOICECORD_UPDATE_KEY_FILE,Env:VOICECORD_PRERELEASE
```

Скрипт проверяет, что ключ соответствует встроенному публичному, и хеширует точный
EXE потоком. Прикрепляйте манифест из той же сборки. Уже опубликованные EXE, теги
и манифесты не заменяйте; выпускайте новую версию. Клиент откажется устанавливать
неподписанный релиз, файл с другим хешем или более старое ранее предложенное
подписанное обновление. Без честного доступного источника нельзя гарантировать,
что посредник не скрывает новый релиз.

Для ротации сначала выпустите клиент с обоими публичными ключами, затем начинайте
подписывать новым. Удалять старый ключ можно после миграции пользователей.
Утрата или компрометация единственного ключа требует отдельного плана восстановления;
сам по себе новый ключ в GitHub не станет доверенным для уже установленных клиентов.

## English

New clients require an Ed25519-signed `update-manifest.json` with every release.
The base64 envelope signs exact JSON payload bytes binding schema, version,
prerelease flag, installer filename, size, SHA-256 and a 365-day validity period.
Embedded public keys live in `electron/update-keys.json`. Keep the private key
outside Git and build artifacts, restrict file permissions, and retain an encrypted
backup. The initial local key is under the current user's
`.codex/secrets/voicecord/update-signing.pem`.

Use the commands above to upload the key as the `VOICECORD_UPDATE_PRIVATE_KEY`
Actions secret or sign locally via `VOICECORD_UPDATE_KEY_FILE`. Tag builds fail
closed without the signing secret; normal builds/PRs do not need it. CI currently
sets `VOICECORD_PRERELEASE=true`; change it before tagging a stable release.
Upload the manifest alongside the exact installer from that build. Never replace
published artifacts; publish a new version. Signing does not enable Windows
Authenticode. Existing clients/servers require an upgrade to gain relay support.

For key rotation, distribute both public keys before signing with the new key.
Clients reject expired manifests and authenticated version rollback, but a relay
can still hide the existence of an update. Losing or compromising the sole signing
key requires a separate recovery plan for already installed clients.
