# Voice, microphones and Push-to-Talk

[Русский](voice.ru.md) · [Documentation](../README.md)

Open **Settings → Audio and devices → Voice** to select an input and output device, adjust input gain and output volume, and test your microphone. If you hear no speech, first verify the device selection and OS microphone permissions.

**Input mode:** choose voice activation with automatic sensitivity, tune a manual threshold if needed, or enable Push-to-Talk and set its shortcut. A high manual threshold can cut quiet speech; an incorrect PTT shortcut can make the microphone appear silent.

**Processing:** PawTalk includes standard WebRTC processing and locally bundled RNNoise neural noise suppression. Echo cancellation, gain control and additional voice suppression can influence the sound; start with a simple configuration and change one option at a time.

**In a channel:** mute disables your microphone; deafen stops playback. You can adjust each other participant's volume separately. Joining a server is not joining voice. A linked-device group has at most one voice session.

A passing automated/audio simulation does not establish real microphone, device, gaming or network performance. [Troubleshooting](troubleshooting.en.md).

Per-participant listening volume and local mute are stored on this Client by Server and profile ID. They survive a complete Client restart and a new voice connection; nicknames and temporary voice identities are not used as storage keys. Linked devices use their effective profile.
