# Operate a Windows Server with Manager

[Русский](management.ru.md) · [Windows setup](first-server.en.md)

Windows Manager provides an interface for viewing the installed Server's state, starting/stopping it and reviewing network/configuration settings. Server runs as a **Windows service**; closing a window is not the same as deleting Server data.

In an Administrator console, open the terminal interface with
`& "$env:ProgramData\PawTalk Server Manager\pawtalkctl.exe" tui`. An installation
with a custom data root takes `--root <path>` before `tui`. Use the arrow keys and
Enter or click an item in the console. Esc goes back. Choose **Stop Server and
exit** in Overview to stop the service explicitly. [Server Core installation](installation.en.md).

Use the Manager UI to inspect the active Server package/version and runtime status. Before editing the address or port, consider that old invitations and remembered server addresses may no longer work; do not manually rewrite TLS identities or server state.

- **User management** (channels, roles, timed invitations, kicks/bans) is done in the **Client** by administrators/moderators, not by granting arbitrary host users the Client role.
- **Host operations** (start/stop, package selection, updates and backups) belong to Manager.
- **Initial administrator** is only available until the Server has been initialized. Do not attempt to regenerate a bootstrap link to recover a lost Client E2EE root.

For connection failures inspect the address and port group, Windows firewall, provider/router rules and actual voice UDP reachability. Never expose the internal media control port (`PORT+3`). [Networking](../../server/networking.en.md).

[Maintenance](maintenance.en.md) · [Roles](../../server/administration.en.md).
