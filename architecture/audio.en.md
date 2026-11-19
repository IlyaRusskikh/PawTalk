# Audio and media pipeline

[Русский](audio.ru.md) · [Index](README.md)

Client captures audio on Windows, selects input devices and implements voice activation/Push-to-Talk controls. The local pipeline includes optional WebRTC processing (echo cancellation and automatic gain) and bundled RNNoise neural noise suppression; gate/worklet and source files live in [`apps/client/windows/src/audio.ts`](../apps/client/windows/src/audio.ts) and [`apps/client/windows/src/gate-worklet.ts`](../apps/client/windows/src/gate-worklet.ts).

The Client uses the LiveKit client SDK for real-time media. The Go Server issues membership-checked media grants, while LiveKit handles the transport/mixer infrastructure; content is protected by end-to-end voice encryption using a apps/server/channel-derived key. E2EE protects media contents, **not traffic timing or membership metadata**.

Joining a server is separate from entering a voice channel. Multiple linked devices can share membership identity, but only one may use voice concurrently. Channel deletion disconnects voice sessions; leaving voice does not necessarily leave the server.

Latency, CPU and speech quality vary with devices, algorithms and networks. Historic benchmark numbers from older pipelines/API 1 are not performance guarantees for published API 2. Real two-PC headset/PTT and remote UDP testing must be recorded separately from synthetic test suites.
