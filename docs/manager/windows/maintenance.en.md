# Windows Server maintenance

[Русский](maintenance.ru.md) · [Windows management](management.en.md)

**Backups:** before changes, use Manager's supported Server backup controls and keep copies off the host. The Server persists identity and encrypted chat/member data, but a Server backup **does not contain** the Client-held E2EE root. Without surviving authorized Client devices/keys, restoring Server files alone cannot decrypt earlier content.

**Updates:** Client, Server and Manager have separate signed release families. Review [compatibility](../../server/compatibility.en.md), back up data, then select a verified compatible Server package using Manager. Updating the Manager application alone does not replace Server. An update/restart interrupts active calls; test joining and voice afterward.

**Recovery:** if a package install fails, retain Manager's transaction state and service data so that its supported retry/recovery path can run. Do not delete state journals, service directories or TLS keys to force a fresh install. A Server API 1 backup is not an API 2 restore input.

**Removal:** decide explicitly whether to keep Server data and copies before uninstalling Manager or Server. Avoid bulk deletion of system services/volumes; verify service ownership and use the provided uninstaller.

No claim is made that Windows 10/11 or Server 2019 received the same live acceptance as Windows Server 2022/2025 CI checks. Verify the real host setup.
