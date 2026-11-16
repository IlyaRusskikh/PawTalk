# Network access and invitations

[Русский](networking.ru.md) · [Documentation](../README.md)

A permanent server normally uses these ports (base port 18443):

| Port | Purpose | Exposure |
| --- | --- | --- |
| TCP 18443 | TLS, API and signaling | Users |
| TCP 18444 | Voice media TCP | Users |
| UDP 18445 | Voice media UDP | Users |
| TCP 18446 | Internal media control | Loopback only — never expose |

The last three are offsets +1, +2 and +3 from the configured base port. On Linux, Manager-managed Compose uses host networking; opening a Docker port mapping is not a substitute for firewall/provider rules.

For internet access you need a reachable public IPv4 and correct router/firewall/provider rules. CGNAT, VPN/proxies, NAT loopback and port forwarding may interfere. A successful TLS/API check does **not** prove UDP/media or an actual call works. Test from a separate network.

**Invitation address:** the client uses its currently saved Server address. If the server was joined by LAN IP, newly created invites may also show LAN IP. To invite an external participant, prefer changing the Client's saved Server address through the server menu while preserving its TLS fingerprint. If that fails because the public IP cannot be reached from LAN, share a copied invite after changing **only the address/required external port**, keeping the fingerprint and full fragment (`#...`) intact. Do not share the link publicly.

[Client diagnostics](../client/troubleshooting.en.md) · [Linux setup](../manager/linux/installation.en.md).
