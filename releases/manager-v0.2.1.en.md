# PawTalk Manager 0.2.1 — Service control and settings fixes

[Русский](manager-v0.2.1.ru.md) · [Canonical snapshot](manager-v0.2.1.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

Fix Windows service control, first settings launch and language switching.

### Fixed

- **Service stop:** tray controls, settings, password reset and uninstall no longer require enabled administrator debug privilege. Use service-control rights and verify actual process exit even when LocalService denies SYNCHRONIZE.
- **Settings launch:** show the window on the first tray launch, without needing a second click.
- **Immediate language:** persist the selection and translate the window/tray without Apply, preserving unrelated unsaved fields.
- **Clearer failures:** uninstall reports the failing phase/code; interactive settings wait for brief maintenance locks.

### Install or update

Run the EXE over the current Manager as administrator. Configuration/data are preserved; host/runtime replacement briefly interrupts calls. An installed Server 0.10.1 needs no replacement. Also install [Client 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.10.1) for saved-room reconnect fixes. A forgotten E2EE secret cannot be recovered from the stored key ID.

## Full release record

The [unchanged bilingual snapshot](manager-v0.2.1.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
