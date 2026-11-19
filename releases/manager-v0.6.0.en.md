# PawTalk Manager 0.6.0 — Terminal management on Linux and Windows

[Русский](manager-v0.6.0.ru.md) · [Canonical bilingual source](manager-v0.6.0.md)

Preview for Windows x64 and Linux. Changes since Manager 0.5.1.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.6.0/PawTalk.Server.Manager.Setup.0.6.0.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.6.0/PawTalk.Server.Manager.TUI.Setup.0.6.0.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.6.0/PawTalk.Manager.0.6.0.tar.gz)

### Added

- A shared TUI with sections for Server setup, start and stop, network settings, updates, diagnostics and backups. Select a backup and confirm its restoration. Arrow keys and mouse navigation are available in supported terminals.
- A separate Windows x64 installer bundles the console host and private Python runtime, with no Electron or tray. Use `/S` for silent setup. Switching from the graphical edition preserves Server data and configuration. Automatic updates select the signed installer for the installed edition.

### Install or update

On Linux, install Manager and run `sudo pawtalkctl tui`. On Windows, run the chosen installer from an elevated PowerShell session. Use `/S` on Server Core. Then run `& "$env:ProgramData\PawTalk Server Manager\pawtalkctl.exe" tui`. For a fresh install, choose “Overview → Set up the first server”. Server 0.13.0 updates independently.

### Limitations

Mouse support depends on the terminal. Service management requires administrator or root privileges. Stopping or restarting Server interrupts active calls. The EXEs have no Authenticode signature.

PawTalk.Server.Manager.Setup.0.6.0.exe · PawTalk.Server.Manager.TUI.Setup.0.6.0.exe · PawTalk.Manager.0.6.0.tar.gz · manager-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.6.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.6.0/LICENSE)
