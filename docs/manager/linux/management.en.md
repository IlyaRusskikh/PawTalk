# Operate Linux Manager

[Русский](management.ru.md) · [First server](first-server.en.md)

After installing Linux Manager, open its terminal menu with `sudo pawtalkctl tui`.
From an existing SSH session, run the same command. When launching it directly
over SSH, allocate a terminal with `ssh -t user@host sudo pawtalkctl tui`.

Use Up and Down to select an item, Enter to open it, or click it in a terminal
that supports mouse input. Use Page Up and Page Down to scroll logs and Esc to
go back. Basic terminals show a numbered menu.

Choose Overview, Network, Security and history, Updates, Backups, or Diagnostics
to open the actions for that section. Use Back or Esc to return to the section list.

The menu shows the server status, address, versions, recent logs and diagnostics.
It can start or stop the server, show the first administrator link until setup is
complete, change the address and base port, adjust the chat history limit, and
switch the interface between English and Russian. Channel encryption is mandatory.

Check and install Server and Manager updates independently, and set automatic
updates for each component. To choose a Server release from disk, select its
signed JSON manifest. Linux pulls the exact image digest from that manifest.
The first-server wizard uses either a published release or a signed manifest.

The menu can create, restore and delete backups.
For a restore, select a backup by its UTC date and name, then confirm. The
restore returns the active server to the state in the backup and disconnects
active calls. Creating a backup also temporarily stops a running server.

For scripting or direct operations, use the `pawtalkctl` commands with sudo.
Keep generated Compose files, Docker volumes and Manager state under Manager control.

~~~bash
sudo pawtalkctl status
sudo pawtalkctl doctor
sudo pawtalkctl logs
sudo pawtalkctl start
sudo pawtalkctl stop
sudo pawtalkctl update check
sudo pawtalkctl manager check
~~~

`status` is a read-only status view, `doctor` diagnoses the installation, and `logs` shows application logs. `update check` and `manager check` discover independently published releases **without installing** them. Container health checks do not prove real remote voice/UDP.

Modify supported runtime settings through the controller, with an explicit backup/stop/restart path:

~~~bash
sudo pawtalkctl configure PAWTALK_CHAT_MAX_MB=256 PAWTALK_BACKUP_KEEP=5 --yes
~~~

Reducing the history limit can prune older messages. `--yes` explicitly authorizes the change. Do not run `configure` concurrently with update or backup. Changing the address or port disconnects active calls and may invalidate existing links. Changing the IPv4 requires a Server that supports `serve rebind` and issues a new TLS certificate. Update firewall and router rules for the new ports.

For service diagnostics:

~~~bash
sudo systemctl status docker --no-pager
sudo systemctl list-timers --all 'pawtalk-*'
sudo journalctl -u pawtalk-health.service -u pawtalk-update.service -n 100 --no-pager
~~~

The health timer performs bounded recovery of unhealthy running containers; it does not convert an intentional stop into a start.

[Backups, updates and uninstall](maintenance.en.md).
