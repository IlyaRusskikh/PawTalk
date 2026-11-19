# Signed updates and distribution trust

[Русский](updates.ru.md) · [Index](README.md)

Client, Server and Manager are **independently versioned and signed**. Client tags use `client-v*`, Server `server-v*`, Manager `manager-v*`. Publication authority is GitHub Releases for that family; neither `package.json` nor global `releases/latest` is a safe substitute.

The Client updater validates an Ed25519-signed update manifest, file hash/size and proper component/version/channel. The Server release uses its own Ed25519 trust roots, server package manifests and OCI image digest for `ghcr.io/ilyarusskikh/pawtalk-server`. The Manager release has separate trust roots and signed metadata for Windows installer/Linux bundle; Linux Manager verifies published dependencies, digests, API/data version and installed state before changing the runtime.

All update paths must fail closed on invalid signing roots, signatures, hashes, stale/untrusted manifest, repository, incompatible schema or wrong component. The host controller performs a transaction with backup/rollback where required. No keys or signature validation may be disabled to force install.

An existing Manager update **does not automatically update Server** unless a separately enabled/confirmed Server update acts. Linux auto-discovery includes published prereleases. [Release process](releasing.en.md) · [Version compatibility](../docs/server/compatibility.en.md).


Client installer transport first samples GitHub, then compares configured room relays with two concurrent probes (at most three retained streams including the current best). A probe measures up to 1 MiB or 1.5 seconds of body data, including connection latency in its rate; headers/room preparation are bounded to 5 seconds. A complete verified artifact wins immediately. The selected stream continues from its buffered prefix; all losing installer streams are aborted/cancelled. Offline and unsupported relays are skipped. A stalled/slow selected stream triggers selection again, excluding that source; transfers are bounded to 15 minutes overall. Download idle/window limits remain 20/30 seconds, with a 64 KiB/s window minimum.

This only changes Client artifact transport, without changing Server/Manager APIs, metadata authority or signatures. The full signed size and SHA-256 are checked before helper launch; an observed hash/size violation fails closed rather than selecting another mirror. Existing relay GET endpoints suffice; no range support or new dependency is required.
