# Signed updates and distribution trust

[Русский](updates.ru.md) · [Index](README.md)

Client, Server and Manager are **independently versioned and signed**. Client tags use `client-v*`, Server `server-v*`, Manager `manager-v*`. Publication authority is GitHub Releases for that family; neither `package.json` nor global `releases/latest` is a safe substitute.

The Client updater validates an Ed25519-signed update manifest, file hash/size and proper component/version/channel. The Server release uses its own Ed25519 trust roots, server package manifests and OCI image digest for `ghcr.io/ilyarusskikh/pawtalk-server`. The Manager release has separate trust roots and signed metadata for Windows installer/Linux bundle; Linux Manager verifies published dependencies, digests, API/data version and installed state before changing the runtime.

All update paths must fail closed on invalid signing roots, signatures, hashes, stale/untrusted manifest, repository, incompatible schema or wrong component. The host controller performs a transaction with backup/rollback where required. No keys or signature validation may be disabled to force install.

An existing Manager update **does not automatically update Server** unless a separately enabled/confirmed Server update acts. Linux auto-discovery includes published prereleases. [Release process](releasing.en.md) · [Version compatibility](../docs/server/compatibility.en.md).
