# First admin and restart acceptance on Linux

[Русский](first-server.ru.md) · [Linux installation](installation.en.md)

After a successful install, create **one first-administrator link**:

~~~bash
sudo pawtalkctl initial-admin --url
printf '\n'
~~~

Pass the full `pawtalk://` link privately to your compatible Windows Client and choose **Join server**. It is not a browser URL. Preserve the certificate fingerprint and secret fragment. The invitation lasts 24 hours and can be consumed once; the Client creates the E2EE root in its OS-protected store. After initialization the host CLI cannot create another bootstrap link.

Joining **does not** join voice automatically. Verify text membership and then a voice call from another real device/network. A healthy container cannot confirm external UDP connectivity.

## Verify lifecycle

~~~bash
sudo pawtalkctl status
sudo pawtalkctl doctor
sudo pawtalkctl logs
sudo docker ps --filter label=io.pawtalk.managed=compose-v1
sudo systemctl list-timers --all 'pawtalk-*'
~~~

Server runs via Docker Compose with `restart: unless-stopped`; there is **no independent `pawtalk-server.service`**. Manager's health/update systemd units are timer-triggered oneshot services, so `inactive (dead)` between activations can be normal.

After first success, schedule a real host reboot when interruption is acceptable, then repeat status/timer checks and rejoin from Client. The running state and history should survive reboot; an intentionally stopped container is not automatically restarted by the watchdog.

[Management](management.en.md) · [Network](../../server/networking.en.md).
