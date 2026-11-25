# Screen sharing in the voice room

[Русский](016-screen-sharing.ru.md)

Keep screen video and optional system audio as distinct LiveKit sources in the existing E2EE voice room. API 2 and API 3 use the explicit source grant as the publishing capability. API 3 applies the same current permission to speak to both new sources during admission and subsequent permission updates. Chat, microphone processing and Manager contracts remain independent of the viewer.

Electron enumerates native sources for the main Client window. A selected source authorizes a single display request for the same frame and requires a user gesture. Monitor sharing offers Windows system loopback. Window sharing offers optional WASAPI process loopback on supported Windows builds. It captures the selected application's process tree, which can include audio from other windows of the application. Client binds access to the selected native window and publishes PCM through a media-stream destination without a local playback connection. The receiving Client mixes screen audio only for the selected remote stream and applies the existing deafen and output controls.

The Windows window list also reports minimized or otherwise unavailable sources so the picker can explain why capture cannot start. The picker refreshes when Client regains focus. Only sources returned by Electron's capture backend can be selected. Resolution presets are bounded by the selected source. For an active window share, Client pauses the LiveKit video publication when the window is minimized. The receiving Client shows a placeholder and resumes the same video publication when the window is restored. API 3 keeps arbitrary data publishing disabled.

This avoids a separate media room or a new membership protocol. Verify grants and restrictions with the server suite, native capture with the Windows Electron fixture, and voice and chat with the membership integration. Earlier Clients can handle loopback audio as an ordinary audio track, so update viewing Clients before using shared system audio.
