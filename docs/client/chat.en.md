# Text chats, channels and devices

[Русский](chat.ru.md) · [Documentation](../README.md)

A server has text and voice channels. Default text/voice channels are protected against deletion. Administrators can add, rename and delete additional channels. **Deleting a text channel destroys its history and attachments** after confirmation; deleting an occupied voice channel disconnects active voice participants without deleting their server membership.

Text chats support messages, formatting, replies, images and navigation to replied-to messages. Read status and unread indicators belong to the client. You can browse chats while not in voice.

Permissions are server-wide in the current API 2 implementation: administrator, moderator and member. There are no private, role-restricted channels with separate encryption roots. A linked-device group shares its current profile/permissions and can edit its own messages, but only one linked device may join voice at once.

**Privacy:** messages/images are end-to-end encrypted. The server still sees metadata such as channel IDs, memberships, timing and traffic sizes. Previously obtained ciphertext and keys cannot be retracted by deleting a membership. [Security details](../../architecture/security.en.md).

## Development source additions

This section describes development source, not the published installers listed in the guide index. Check your installed release for availability.

- Edit your message to remove an image; saving without text or an image deletes the message completely.
- Right-click a server/text chat to mute notifications for 15 minutes, 1, 3, 8 or 24 hours, or until you turn them on. Server mute takes priority; muted counters are gray. Preferences belong to this device.
- Type **@** and select a member with the mouse or arrow keys and Enter/Tab. Only selected mentions address a profile; ordinary matching text does not. Mentions bypass server/chat mutes, use the theme accent, and leave an unread pin after an offline period. Sound settings, deafen and OS restrictions still apply. The down arrow at the lower right returns to the latest messages and shows a new-message counter.
- Use the attachment menu → **Create poll**: a question up to 300 characters, 2–10 answers up to 100 characters each (emoji supported), duration 1, 4, 8 or 24 hours, 3 days, 1 or 2 weeks. Multiple answers, anonymous voting and interim results are configurable. Click a selected choice to withdraw; another choice replaces a single-choice vote. Defaults: 24 hours, one answer, anonymous voting and visible interim results.
- Authors can end polls early; published polls cannot be edited. At expiry, Server posts a separate result reply linking to the original, even with the author offline. Ties show all winners; no votes means no winner. Anonymous polls hide identities from members, **not the server operator**. Hidden interim results remain hidden until completion, including from voters.
- Administrators change/remove the shared server avatar in its context menu, using square cropping.
- Close the device-link code window while waiting. Incoming confirmation reopens over current work and restores/focuses the app. Closing confirmation rejects that request; the previous form and its draft stay open.
- After five minutes without system keyboard/mouse activity, presence becomes **Away** (yellow), including in voice calls, and appears in the lower user panel. Activity restores Online; manual Away selection is unavailable. A linked profile stays Online while any live linked session is active.
- Microphone/deafen, device menus and disconnect are duplicated in the call area; bottom user controls remain.

Server extensions require matching [API 2 capabilities](../server/compatibility.en.md). Basic chat/voice remain available on older API 2 servers. [Technical contracts](../../architecture/chat-features.en.md).
