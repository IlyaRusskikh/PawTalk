# Install Windows Client

[Русский](installation.ru.md) · [Documentation](../README.md)

1. Open the [Client download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/#client). Choose the **published Windows installer** for the Client family, not a source-code archive or a Server/Manager package.
2. Download the installer and the checksum file attached to **the same release**. Verify the SHA-256 hash in PowerShell (replace the example filename):
   `Get-FileHash -LiteralPath "PawTalk.Setup.VERSION.exe" -Algorithm SHA256`
3. Compare the output with `SHA256SUMS.txt` from that release. If it differs, do not run the installer. A checksum proves file integrity relative to the published value; it is not an Authenticode signature or security audit.
4. Run the installer and open PawTalk. Set your display name and select your microphone and speakers in the first-run guide.

The installer is currently not Authenticode-signed, so Windows may display an unknown-publisher warning. Verify the source and hash before deciding whether to proceed.

**Updating:** use the Client update interface or install the new published Client over the existing installation. Client, Server and Manager have **independent** releases. Upgrading the Client does not upgrade a permanent Server. [Compatibility](../server/compatibility.en.md).

On Windows, the installed shortcut, running Client and taskbar relaunch use the same application identity. Startup-in-tray does not change this identity. If a pin created by an older Client still shows a duplicate icon after updating, unpin it once, start the updated installed Client and pin its running icon again.
