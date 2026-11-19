# Transport and network boundaries

[Русский](networking.ru.md) · [Index](README.md)

PawTalk separates the TLS/HTTP control path from LiveKit media. The configured base port (`PORT`, usually **18443**) determines four listeners:

| Listener | Use | Exposure |
| --- | --- | --- |
| TCP `PORT` | HTTPS/API and signaling | Users |
| TCP `PORT+1` | Media over TCP | Users |
| UDP `PORT+2` | Media over UDP | Users |
| TCP `PORT+3` | Internal media control | Loopback only |

Linux Manager controls Docker Compose with `network_mode: host`, not a user-created Swarm or Caddy stack. Windows permanent Server is native service managed by Manager; temporary Server lives under Client. TCP/UDP, firewall/provider routing and fixed IPv4 must be coordinated across the host and external network.

Linux Manager changes the address and port through the configuration transaction. After taking a backup and stopping the server, it verifies the existing TLS and room identity from the installed image in a container without networking. A port change retains the certificate. An IP change uses `serve rebind` to replace the certificate and keeps the same membership server ID. A previously running server must pass health and identity checks before the transaction is committed.

Client invitations carry a host address, TLS certificate fingerprint and an encrypted-key fragment. The fragment stays client-side rather than becoming an HTTP admission key. The address saved on a Client may be LAN IP; clients behind NAT loopback restrictions may need to share a correctly edited external-address invitation without changing the fingerprint/fragment.

An HTTP `/healthz` response tests neither the UDP path nor physical audio. Production confidence needs a real Client-to-Client call from separate networks. See [user network guide](../docs/server/networking.en.md).
