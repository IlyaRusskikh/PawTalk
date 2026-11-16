# Install Server Manager on Windows

[Русский](installation.ru.md) · [Manager overview](../overview.en.md)

**Purpose:** use Manager on the computer that will run a permanent Windows Server. It is not the application that joins voice chats. The published Manager installer targets Windows x64; Windows 10/11 and Windows Server 2019/2022/2025 are target platforms, but testing coverage differs by OS.

1. Download **Manager** from the [published Manager releases](https://ilyarusskikh.github.io/PawTalk/downloads/#manager), not a Client installer or Server ZIP.
2. Review the chosen release's signed metadata/checksum and installation limitations. The Manager installer itself selects its interface language.
3. Run the installer with the permissions requested for its service management. Windows UAC may prompt during service installation.
4. Launch Manager and proceed to [first Server setup](first-server.en.md). **No Server is downloaded or installed merely by installing Manager.**

Do not confuse Manager with the **Server**: Manager controls Server lifecycle and settings, while Server handles actual user membership, voice and chat. A Manager reinstall preserves an existing Server and its running/stopped state; it does not reset Server data.

Manager and Server need a compatible published API/data schema 2 combination. See [compatibility](../../server/compatibility.en.md).
