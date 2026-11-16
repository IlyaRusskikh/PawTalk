# Install permanent PawTalk Server on Linux

[Русский](installation.ru.md) · [Manager overview](../overview.en.md)

This is the fresh-host path for **published API 2** using **Linux Manager**. Supported platform: **Debian 12 Bookworm or Ubuntu 24.04 LTS, amd64/arm64, systemd**. Debian 13, other distributions, rootless Docker, IPv6-only servers and armhf are not supported by this published Manager.

Requirements: a fixed public IPv4, root/sudo, Python 3.11+, OpenSSL 3, trusted CA certificates, outbound HTTPS to GitHub/GHCR, accurate clock, Linux Docker Engine and Compose plugin **v2+**. Preflight checks 1 GiB free space, but that is not a capacity recommendation; keep headroom for images, history and backups. Keep SSH/provider console access.

## 1. Prepare the host

Run in Bash as a normal user with sudo (omit sudo if logged in as root).

~~~bash
sudo apt-get update
sudo apt-get install -y python3 openssl ca-certificates git curl iproute2
cat /etc/os-release
dpkg --print-architecture
python3 --version
openssl version
df -h / /var
sudo ss -lntup
~~~

Open only TCP `PORT`, TCP `PORT+1` and UDP `PORT+2` in your firewall/provider router (usually 18443, 18444, 18445); **never** expose internal TCP `PORT+3` (usually 18446). Choose the IPv4 and base port carefully: **Linux Manager does not support changing them for an installed Server**.

## 2. Obtain a trusted bootstrap checkout

Bootstrap runs as root; do not use `curl | sh` or an unreviewed commit. Obtain the **full 40-character SHA** for a reviewed source revision that contains the current Manager trust roots, and verify it before proceeding:

~~~bash
git clone --no-checkout https://github.com/IlyaRusskikh/PawTalk.git pawtalk-bootstrap
cd pawtalk-bootstrap
read -r -p 'Reviewed full 40-character SHA: ' PAWTALK_BOOTSTRAP_SHA
[[ "$PAWTALK_BOOTSTRAP_SHA" =~ ^[0-9a-f]{40}$ ]] &&
  git checkout --detach "$PAWTALK_BOOTSTRAP_SHA" &&
  test "$(git rev-parse HEAD)" = "$PAWTALK_BOOTSTRAP_SHA"
sha256sum manager/trust.json
python3 -B -I manager/pawtalkctl --self-test
~~~

Review the checkout and `manager/trust.json` against your trusted source; do not substitute random trust roots. A failed check must stop installation.

## 3. Install Manager and Server

If Docker is already installed, check `sudo docker info --format '{{.OSType}}'` and `sudo docker compose version --short` (Linux, Compose major 2+). If Docker is absent, the supported installer can bootstrap it from the **official** apt repository:

~~~bash
sudo python3 -B -I manager/pawtalkctl --lang en install --bootstrap-docker
sudo pawtalkctl --lang en status
sudo pawtalkctl doctor
~~~

The interactive installer asks for public IPv4, port, history limit and update preferences, verifies signed Manager/Server releases, creates managed Compose/volume state, and checks health. **Do not run `docker compose up` manually against the bootstrap checkout.** If anything fails, preserve the transaction files for recovery.

Continue with [first administrator](first-server.en.md). After installation, the bootstrap clone can be removed only when `sudo pawtalkctl doctor` confirms an installed healthy Manager; do not touch `/etc/pawtalk`, `/var/lib/pawtalk-manager` or Docker volumes.
