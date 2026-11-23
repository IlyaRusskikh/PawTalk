# 014. Media previews and viewing copies

[Русский](014-media-variants.ru.md)

The Windows Electron benchmark compared the original path, static previews, and static previews with a separate viewing copy. For 36 photos of 1.87 MB each, traffic during scroll fell from 67.43 MB to 1.27 MB with previews. At a simulated 25 Mbps, a 0.59 MB viewing copy cut photo opening time from about 0.72 s to 0.31 s. Existing video posters already kept scroll smooth. The trial video encoder took approximately the full clip duration, so the Client retains original video playback.

Prepare bounded static previews by default and add a viewing copy only for a large static photo when it halves its size and fits the existing attachment quota. Preserve the original bytes. With original size `S`, viewing-copy size `V`, and `M` uncached views, the incremental transfer compared with previews alone is `V − M × (S − V)` bytes. Stored size grows by `V` bytes. The threshold also accounts for preparation time and upload time.

The benchmark uses production renderer components, synthetic assets, and a simulated transfer. It measures scroll and open latency, while the encrypted attachment integration covers access and byte preservation. See [the media contract](../../architecture/chat-features.en.md#media-variants).
