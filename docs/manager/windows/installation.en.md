# Install Server Manager on Windows

[Русский](installation.ru.md) · [Manager overview](../overview.en.md)

**Purpose:** use Manager on the computer that will run a permanent Windows Server. It is not the application that joins voice chats. The published Manager installer targets Windows x64; Windows 10/11 and Windows Server 2019/2022/2025 are target platforms, but testing coverage differs by OS.

1. Download **Manager** from the [published Manager releases](https://ilyarusskikh.github.io/PawTalk/downloads/#manager), not a Client installer or Server ZIP.
2. Review the chosen release's signed metadata/checksum and installation limitations. The Manager installer itself selects its interface language.
3. Run the installer with the permissions requested for its service management. Windows UAC may prompt during service installation.
4. Launch Manager and proceed to [first Server setup](first-server.en.md). **No Server is downloaded or installed merely by installing Manager.**

Do not confuse Manager with the **Server**: Manager controls Server lifecycle and settings, while Server handles actual user membership, voice and chat. A Manager reinstall preserves an existing Server and its running/stopped state; it does not reset Server data.

Manager and Server need a compatible published API/data schema 2 combination. See [compatibility](../../server/compatibility.en.md).

## TUI-only installation on Windows 11 and Windows Server Core

On the Manager release page, choose the asset named
`PawTalk.Server.Manager.TUI.Setup.<version>.exe` when available. It includes the
console host and its private Python runtime. Installing it over the graphical
edition removes the desktop app, tray and their shortcuts while preserving Server
data and configuration. Automatic Manager updates follow the installed edition.

Run the verified installer in silent mode from an Administrator PowerShell session.
Replace the filename with the one you downloaded.

```powershell
$setup = (Resolve-Path '.\PawTalk.Server.Manager.TUI.Setup.<version>.exe').Path
$install = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Manager installation failed ($($install.ExitCode))" }
& "$env:ProgramData\PawTalk Server Manager\pawtalkctl.exe" tui
```

Open **Overview → Set up the first server** to install a published Server or to
select a local Windows Server ZIP. To use Russian, run `pawtalkctl.exe --lang ru tui`.
See [terminal controls](management.en.md).
