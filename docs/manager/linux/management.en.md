# Operate Linux Manager

[Русский](management.ru.md) · [First server](first-server.en.md)

Linux Manager's installed CLI `pawtalkctl` is the supported control surface. Run host commands with sudo; do not edit generated Compose files, Docker volumes or Manager state manually.

~~~bash
sudo pawtalkctl status
sudo pawtalkctl doctor
sudo pawtalkctl logs
sudo pawtalkctl update check
sudo pawtalkctl manager check
~~~

`status` is a read-only status view, `doctor` diagnoses the installation, and `logs` shows application logs. `update check` and `manager check` discover independently published releases **without installing** them. Container health checks do not prove real remote voice/UDP.

Modify supported runtime settings through the controller, with an explicit backup/stop/restart path:

~~~bash
sudo pawtalkctl configure PAWTALK_CHAT_MAX_MB=256 PAWTALK_BACKUP_KEEP=5 --yes
~~~

Reducing the history limit can prune older messages. `--yes` explicitly authorizes the change. Do not run `configure` concurrently with update or backup. Installed Linux Server **cannot change IP or base port** through this Manager; do not bypass that restriction by editing Compose or installed state.

For service diagnostics:

~~~bash
sudo systemctl status docker --no-pager
sudo systemctl list-timers --all 'pawtalk-*'
sudo journalctl -u pawtalk-health.service -u pawtalk-update.service -n 100 --no-pager
~~~

The health timer performs bounded recovery of unhealthy running containers; it does not convert an intentional stop into a start.

[Backups, updates and uninstall](maintenance.en.md).
