# Release descriptions

[Русский](README.ru.md) · [Change history](../changelog/README.md)

The bilingual `<tag>.md` files are canonical local publication sources, preserved unchanged during this documentation move; `<tag>.en.md` and `<tag>.ru.md` provide human-readable language-specific versions. Candidate plans bind the canonical source digest. Failed candidate notes do **not** imply publication.

Local sources are not automatically exact snapshots of public Release bodies. The audit on 17 November 2026 found that `client-v0.12.1`, `server-v0.11.1` and `manager-v0.5.1` still have temporary publication/CI wording on GitHub that has already been removed locally. Compare with `node scripts/check-release-notes.mjs --published <tag>`; any public correction requires [separate owner approval](../architecture/release-recovery.en.md). Do not overwrite local sources or public descriptions to hide a mismatch.

## Client

- [client-v0.9.0](client-v0.9.0.en.md)
- [client-v0.10.0](client-v0.10.0.en.md)
- [client-v0.10.1](client-v0.10.1.en.md)
- [client-v0.11.0](client-v0.11.0.en.md)
- [client-v0.12.0](client-v0.12.0.en.md) — failed, unpublished candidate
- [client-v0.12.1](client-v0.12.1.en.md)
- [client-v0.13.0](client-v0.13.0.en.md) — release source

## Server

- [server-v0.9.0](server-v0.9.0.en.md)
- [server-v0.10.1](server-v0.10.1.en.md)
- [server-v0.11.0](server-v0.11.0.en.md) — failed, unpublished candidate
- [server-v0.11.1](server-v0.11.1.en.md)
- [server-v0.12.0](server-v0.12.0.en.md) — release source

## Manager

- [manager-v0.1.0](manager-v0.1.0.en.md)
- [manager-v0.2.0](manager-v0.2.0.en.md)
- [manager-v0.2.1](manager-v0.2.1.en.md)
- [manager-v0.3.0](manager-v0.3.0.en.md)
- [manager-v0.4.0](manager-v0.4.0.en.md)
- [manager-v0.5.0](manager-v0.5.0.en.md) — failed, unpublished candidate
- [manager-v0.5.1](manager-v0.5.1.en.md)

[Published GitHub Releases](https://github.com/IlyaRusskikh/PawTalk/releases) determine which tag exists for users. Never pin one global `releases/latest` URL.
