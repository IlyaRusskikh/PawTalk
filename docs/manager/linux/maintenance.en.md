# Linux Manager maintenance

[Русский](maintenance.ru.md) · [Management](management.en.md)

## Updates

Review release-specific compatibility and make a backup before maintenance. Check without applying, then update Manager and Server deliberately:

~~~bash
sudo pawtalkctl manager check
sudo pawtalkctl update check
sudo pawtalkctl backup create
sudo pawtalkctl manager now
sudo pawtalkctl update now
sudo pawtalkctl doctor
~~~

An update/restart interrupts calls. Signed packages/digests are verified; update failures attempt to restore image **and** data. Do not replace images outside Manager. Linux automatic updates can be enabled with:

~~~bash
sudo pawtalkctl configure PAWTALK_SERVER_AUTO_UPDATE=true PAWTALK_MANAGER_AUTO_UPDATE=true --yes
~~~

Use `false` values to disable; periodic discovery includes published prereleases. No stable-only switch is provided by this Linux CLI.

## Backup and restore

~~~bash
sudo pawtalkctl backup create
sudo pawtalkctl backup list
~~~

Backup briefly stops Server, copies consistent state and restarts a previously running container. Keep the complete private backup directory **off the VPS** using a secure transfer. To restore an existing instance:

~~~bash
read -r -p 'Backup name from list: ' PAWTALK_BACKUP_NAME
sudo pawtalkctl backup restore "$PAWTALK_BACKUP_NAME"
sudo pawtalkctl doctor
~~~

Restoring to a fresh supported host is a separate procedure: copy the full backup to `/var/backups/pawtalk/` with private root permissions, prepare a trusted checkout and Docker/Compose, **do not install a new Server first**, then run `sudo python3 -B -I apps/manager/linux/pawtalkctl backup restore "$PAWTALK_BACKUP_NAME" --trust apps/manager/linux/trust.json` from that checkout. The old IP/base port and saved GHCR image digest must remain available. No API 1 migration. Server backups never contain Client E2EE roots.

For a protected room, keep Client devices that hold newer signed checkpoints. A Client that detects a policy rollback pauses affected sends. If only the older backup survives, its signatures establish the state at the time of the backup. Detecting and reconciling later changes to roles and device revocations requires surviving verifiable evidence newer than that copy.

## Stop and uninstall without erasing data

~~~bash
sudo pawtalkctl uninstall --keep-data
~~~

This only removes Manager-owned containers and disables timers; configuration, backup and data remain. There is no blanket purge command. **Never use `docker system prune` or remove all volumes** to uninstall PawTalk. Check project and volume identity and securely export copies before any deliberate irreversible cleanup.

[Storage and trust](../../server/overview.en.md).
