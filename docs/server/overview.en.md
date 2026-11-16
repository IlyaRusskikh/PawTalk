# PawTalk Server: temporary or permanent?

[Русский](overview.ru.md) · [Documentation](../README.md)

**Temporary server:** started by Windows Client using the shared server core. The creator is its administrator. Server state and chat history are in memory and disappear when the host shuts down. Use it for short sessions with friends; the host computer must remain online.

**Permanent server:** runs independently on Windows (native service) or Linux (Manager-controlled Docker Compose). It persists membership and encrypted messages in SQLite plus server configuration. Install it using the matching [Windows Manager](../manager/windows/installation.en.md) or [Linux Manager](../manager/linux/installation.en.md).

Both implement the published API 2 protocol, channels, invitations, E2EE and roles. Client, Server and Manager update independently. Download them from their own published release families; historical API 1 installations have no automatic data migration.

Unlike a central account service, server membership is local to a PawTalk Server. Your Server owner/administrator is responsible for uptime, access, backups and network firewall rules.
