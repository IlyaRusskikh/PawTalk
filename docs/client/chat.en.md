# Text chats, channels and devices

[Русский](chat.ru.md) · [Documentation](../README.md)

A server has text and voice channels. Default text/voice channels are protected against deletion. Administrators can add, rename and delete additional channels. **Deleting a text channel destroys its history and attachments** after confirmation; deleting an occupied voice channel disconnects active voice participants without deleting their server membership.

Text chats support messages, formatting, replies, images and navigation to replied-to messages. Read status and unread indicators belong to the client. You can browse chats while not in voice.

Permissions are server-wide in the current API 2 implementation: administrator, moderator and member. There are no private, role-restricted channels with separate encryption roots. A linked-device group shares its current profile/permissions and can edit its own messages, but only one linked device may join voice at once.

**Privacy:** messages/images are end-to-end encrypted. The server still sees metadata such as channel IDs, memberships, timing and traffic sizes. Previously obtained ciphertext and keys cannot be retracted by deleting a membership. [Security details](../../architecture/security.en.md).

## Development source additions

This section describes development source, not the published installers listed in the guide index. Check your installed release for availability.

- Compatible builds deliver new encrypted messages, edits and deletions over WebSocket without a separate history request. Initial history, scrolling and gap recovery use HTTP. Sending still uses HTTP; older Servers retain event invalidation or periodic updates.
- History loads automatically as you scroll, without previous/next buttons. **Settings → Chat → Messages per batch** controls the initial/latest load and each older/newer request (25–500, default 100). Loaded messages stay in this open chat's RAM cache, including the latest block when following a distant reply. Returning to cached history does not fetch it again. Leaving the chat releases the cache; memory pressure frees distant history while preserving the reading position. Reopening normally loads the latest batch, or restores a saved reading position. Images remain lazy-loaded.
- Your outgoing message appears gray immediately, including its image preview during upload. Server acknowledgment restores its normal color; this confirms receipt by Server, not reading by another participant. If sending fails, the draft remains available for retry.
- Edit your message to remove an image; saving without text or an image deletes the message completely.
- Right-click a apps/server/text chat to mute notifications for 15 minutes, 1, 3, 8 or 24 hours, or until you turn them on. Server mute takes priority; muted counters are gray. Preferences belong to this device.
- Desktop alerts are grouped per chat: a newer alert replaces the previous one. Reading the corresponding messages on this device cancels pending alerts and dismisses their native notification, including its Windows Action Center entry. Windows alerts show the sender’s circular avatar (or initial when no photo is set). Opening the app alone does not mark other chats as read.
- Type **@** and select a member with the mouse or arrow keys and Enter/Tab. Suggestions include avatars. You can also drag a member from the roster into the chat to insert a mention. Only selected or dragged mentions address a profile; ordinary matching text does not. Mentions bypass apps/server/chat mutes, use the theme accent, and leave an unread pin after an offline period. Sound settings, deafen and OS restrictions still apply. The down arrow at the lower right returns to the latest messages and shows a new-message counter.
- Use the attachment menu → **Create poll**: a question up to 300 characters, 2–10 answers up to 100 characters each (emoji supported), duration 1, 4, 8 or 24 hours, 3 days, 1 or 2 weeks. Multiple answers, anonymous voting and interim results are configurable. Click a selected choice to withdraw; another choice replaces a single-choice vote. Defaults: 24 hours, one answer, anonymous voting and visible interim results.
- Authors can end polls early; published polls cannot be edited. At expiry, Server posts a separate result reply linking to the original, even with the author offline. Ties show all winners; no votes means no winner. Anonymous polls hide identities from members, **not the server operator**. Hidden interim results remain hidden until completion, including from voters. Visible non-anonymous votes show avatars below each option; hover +N to see every voter. Results appear from System; results and completed polls cannot be deleted by users.
- Administrators change/remove the shared server avatar in its context menu, using square cropping with a dashed circular safe area inside.
- Close the device-link code window while waiting. Incoming confirmation reopens over current work and restores/focuses the app. Closing confirmation rejects that request; the previous form and its draft stay open.
- After five minutes without system keyboard/mouse activity, presence becomes **Away** (yellow), including in voice calls, and appears in the lower user panel. Activity restores Online; manual Away selection is unavailable. A linked profile stays Online while any live linked session is active.
- Microphone/deafen, device menus and disconnect are duplicated in the call area; bottom user controls remain.

Server extensions require matching [API 2 capabilities](../server/compatibility.en.md). Basic chat/voice remain available on older API 2 servers. [Technical contracts](../../architecture/chat-features.en.md).

## Protected rooms in API 3 development builds

Channel permissions determine which rooms you see, where you can post and which history you can open. If access begins partway through a channel's history, earlier messages and references can remain unavailable. Search, gallery and pinned messages follow the same access as the original message.

The protection indicator has four named states. Focus, hover or click it for an explanation. While a key is being updated, you can keep typing. After the previous key expires, **Send when the key is updated** queues the text for a verified key. If you lose access and join again, you can review and send the retained draft yourself. Notification mutes are available in server and text-channel menus. A member with permission to edit community settings can change the server name and avatar in the server menu. [Compatibility](../server/compatibility.en.md#protected-access-api-3).

## Media, checklists and preview in development builds

Use **+ → Send file** for GIF, MP4/WebM video, audio and documents. Click a GIF attachment to play it in the viewer. Video and audio have playback controls. Documents download with their original bytes, without compression. PNG/JPEG/WebP remain limited to 2 MB. Other files support 50 MB with a Server advertising media-files-v1, or 2 MB on older API 2 Servers. Unsupported video formats are downloadable documents.

**+ → Record voice message** replaces the input with an inline recorder: live microphone waveform, timer, Stop, Discard and Send. Click Send while recording to stop and send in one step. Click Stop to review the recording before sending. Sent voice messages have play/pause, a seekable waveform with remaining time, speeds 1× → 1.5× → 2× → 0.75×, and listener volume (0–200%, default 100% at the slider midpoint; hover the speaker for the vertical control). Right-click a voice message to save its file. **+ → Interactive checklist** requires checklists-v1. Enter a title and items, and choose whether everyone or only the author may check them. The author can edit the title, items and permissions later; retained items keep their checks. Compatible Servers push committed checks over WebSocket immediately; polling is retained only for older Servers or a disconnected stream.

Select text to open formatting tools; **MD** offers headings, lists, a rule and a code block. The active eye button has a background and closed-eye icon; it replaces editable input with a read-only preview at exactly the same height. Hover MD for an icon menu; hover headings or lists for their submenus. Tables remain supported as typed Markdown, with no table insertion tool. Before sending a standalone HTTPS link, the Client checks for GIF bytes or a single Tenor/Giphy/Klipy GIF page. Search pages preview the first verified animation in provider result order. A resolved GIF displays inline; failed resolution/loading keeps the original link. Existing standalone provider links are also resolved when displayed. GIF-format video loops silently. GIFs normally load directly without a referrer. If Chromium cannot load a provider animation, the main process retries with a bounded transport (20 MiB, 20 seconds, two simultaneous loads); decoded media uses a temporary local Blob URL. Consecutive messages show only the time beside the row on hover; focus or hover the time for its full date. The chat scrollbar appears while scrolling.


Photo/video drafts appear as cards above the message field, with filename, preview, rename and remove controls. You can attach up to ten files, with a 2 MiB limit per photo and 50 MiB per video. With media-variant support the sender generates small static previews for photos, video and GIF attachments. Open a card to see the media. Large photos can open a smaller viewing copy, and **Download original** retrieves the source file.

Click a video’s play overlay to open the custom viewer inside PawTalk with autoplay, author/date, download, timeline, volume and fullscreen controls. Previous/next navigate this message’s photos and videos in attachment order. Volume defaults to 100%, ranges from 0–200%, and opens vertically on hover. Fullscreen covers the monitor while retaining the custom controls. Esc first exits fullscreen, then closes the viewer; Space toggles playback and Left/Right seek five seconds. Panels hide after two seconds without pointer activity during playback, while keyboard-focused controls remain available. Multiple attachments and shared video previews require `media-gallery-v1` on Server and an updated receiving Client. Older video messages without a saved preview retain a playable placeholder.

Dragging any file over the PawTalk window while a text chat is open shows a drop overlay naming the destination chat. Dropping adds draft cards for review and a comment; it does not send immediately.

Multiple message attachments use a two-column grid, including mixed photos, videos and documents. Photos open in the same viewer shell as videos, with sender/date, download, navigation through that message’s photos and videos, and native fullscreen; single-photo zoom/copy controls remain available. Draft photos use the same viewer.

Gallery photos also support zoom buttons, the mouse wheel, double-click zoom/reset and dragging while enlarged. Zoom resets when switching attachments.
