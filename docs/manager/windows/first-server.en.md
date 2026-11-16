# Create the first Windows Server

[Русский](first-server.ru.md) · [Windows installation](installation.en.md)

1. Open Manager after installing it. In the initial Server setup screen select a **local Server ZIP/portable package** or explicitly choose to **download a published compatible Server**. There is no hidden automatic Server download.
2. Set the intended host IPv4 address, base port (normally 18443), chat history size and update preferences. Check that both public TCP ports and UDP media port are available; keep the internal listener private. [Port table](../../server/networking.en.md).
3. Review and confirm installation. Manager verifies trusted published packages; a local imported package requires an explicit approval path. Allow service installation/UAC if prompted.
4. Start Server and check that Manager reports a healthy running instance. A healthy API service is not proof of external UDP/voice.
5. Use the Manager UI to create the **first administrator invitation**. Open the complete `pawtalk://` link in a compatible Windows Client, which creates the E2EE root in its local protected storage. The bootstrap link expires after 24 hours and is used once.
6. Join a text channel, then a voice channel, and test another device/network. Further administrators join with ordinary invitations and are promoted by an existing administrator.

The fresh API 2 Server cannot import API 1 membership/chat backup automatically. Never share initial-admin links in logs or public issues.

[Operating Manager](management.en.md) · [Maintenance](maintenance.en.md).
