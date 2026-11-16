# Client troubleshooting

[Русский](troubleshooting.ru.md) · [Documentation](../README.md)

| Symptom | What to check |
| --- | --- |
| Cannot join | Use a complete, unexpired invitation; verify the Server API 2 version, public address, TLS certificate fingerprint and current network |
| Connected to server, no audio | Enter a voice channel, check mute/deafen, correct devices, PTT/voice activation, output levels |
| Room works on LAN but not internet | Check CGNAT, firewall, router forwarding for both TCP ports and UDP, then test from a different network |
| Invite works locally but not externally | Ensure the address in the copied invitation is public; retain the correct TLS fingerprint and secret fragment |
| Server says incompatible version | API 1 does not work with API 2; select a published compatible Client/Server/Manager set |
| Joined but chat content is unavailable | Check membership and encryption/device state; a Server backup does not restore client-held E2EE roots |

Do not disable fingerprint validation or E2EE to work around errors. Capture **sanitized** symptoms and version/tag names in [GitHub Issues](https://github.com/IlyaRusskikh/PawTalk/issues/new/choose), never live invitations, credentials or private IP reports.

[Networking](../server/networking.en.md) · [Compatibility](../server/compatibility.en.md).
