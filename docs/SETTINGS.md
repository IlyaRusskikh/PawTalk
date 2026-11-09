# Settings organization

The November 2026 settings audit uses the supplied Discord desktop screenshots as the layout reference. All existing PawTalk settings are retained; stored keys and defaults are unchanged.

| Location | Existing controls | Reference behavior |
| --- | --- | --- |
| User settings → About me | Avatar, nickname | Personal profile |
| Audio and devices → Voice | Input/output devices, input gain, output volume, microphone test | Two device columns, volume sliders, test button and meter |
| Voice → Input mode | Voice activation, automatic/manual sensitivity, Push-to-Talk key and release delay | Input controls next to microphone processing |
| Voice → Processing | Noise suppression, echo cancellation | Select row and switch row |
| Voice → Advanced | Automatic gain, nearby voice suppression, attenuation amount and triggers | Collapsible advanced controls; attenuation grouped with audio |
| Audio and devices → Sounds | Notification toggle, shared notification volume, meow/purr previews | Separate sounds subsection |
| Application → Appearance | Theme presets, all 13 custom colors, font size, radius, message spacing | Visual customization |
| Application → Chat | Visible message window | Chat-specific behavior |
| System → General | Windows sign-in launch, launch in tray | Startup controls and dependent disabled state |
| System → Shortcuts | Microphone and all-audio shortcuts | One action/shortcut row per supported action |
| System → Updates | Automatic checks, current version, manual check | Application maintenance |
| Region → Language | Russian/English | Separate language page |

Reset appears once, at the end of each page that supports it, outside anchor subsections. The audio page resets devices, input, processing, attenuation and notification preferences together. The system page retains its existing reset scope of the two keyboard accelerators. Appearance retains its existing color-only reset. Language, startup, profile and updates retain their existing persistence mechanisms.

PawTalk-specific RNNoise, nearby voice suppression, cat previews and custom colors remain available. Discord-only camera, streaming, soundboard, Krisp, input profiles and hardware-acceleration controls are omitted because PawTalk has no matching implementation.

Validation: built-renderer Electron smoke uses Chromium synthetic audio; it does not establish real-device audio quality. Navigation, reset boundaries, persisted preferences and layouts are checked independently of the audio engine.

Audio and devices is one continuous page with Voice and Sounds anchors. System is one continuous page with General, Shortcuts and Updates anchors. Anchor clicks preserve mounted controls and expanded advanced options; manual scrolling updates the highlighted subsection. All pages share one 700px content column, consistent heading spacing and a stable scrollbar gutter.

Anchor scrolling is animated, except when the system requests reduced motion.
