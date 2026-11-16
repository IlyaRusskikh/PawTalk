# Server Manager: Windows and Linux

[Русский](overview.ru.md) · [Documentation](../README.md)

**PawTalk Server Manager** installs and operates a **permanent** PawTalk Server. It is not an alternative voice/chat client. Windows and Linux Manager belong to the **same Manager release family** and have one `manager-v*` version number.

On **Windows**, install Manager as a Windows application. Its Electron interface selects a locally imported Server package or explicitly downloads a verified published Server, configures settings and operates a native service.

On **Linux**, the installed `pawtalkctl` CLI manages a signed Server container through Docker Engine, the Compose plugin and systemd timers. The official fresh-host path supports Debian 12 and Ubuntu 24.04 LTS on amd64/arm64.

The Manager installer/bundle does not silently install or update a running Server. Server and Manager are separate releases. Backups contain server data and receipts, not Client-held E2EE decryption roots.

[Windows setup](windows/installation.en.md) · [Linux setup](linux/installation.en.md) · [Compatibility](../server/compatibility.en.md).
