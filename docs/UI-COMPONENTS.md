# Application UI components

Use existing application primitives before writing screen-specific styles. No external UI dependency is required.

- `src/ui/Button.tsx`: primary, secondary, quiet and danger variants; shared radius, spacing, disabled and focus behavior.
- `Controls.tsx`: Icon (inline SVG), Toggle, Slider. Extend the existing icon set.
- `Modal.tsx`: dialog lifecycle, heading, errors, focus and close handling.
- `.form-fields` / `.form-grid`: shared field geometry; `.modal-actions`: aligned action buttons.
- `SettingsShell`: settings navigation, sections and tab highlighting.
- `ConnectionStatus`: common hover RTT and connection quality dialog.
- `MessageText`: formatted messages and safe reply previews.
- `ui/useReorderDrag`: transparent native drag images and live slot previews for
  server/channel lists; commits once on drop, preserves order on cancel and
  respects reduced motion. Keep stable item keys and use the returned list/item
  properties on the actual list and its direct item children.

New screens should compose these primitives. Convert existing controls incrementally when touching them; theme colors and dimensions remain CSS variables.

`ui/AudioStatusIcons` shares microphone, deafen and locally-muted indicators between
call cards and compact channel avatars. It uses the active LiveKit snapshot;
unknown audio state in other channels is not rendered as an inferred mute state.

`ui/AvatarStrip` measures available width and keeps compact participants in one row.
When full, the final slot becomes +N. Use it for channel avatars and server hover
previews; participant audio indicators remain children of each visible avatar.
