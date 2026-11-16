# Text chats, channels and devices

[Русский](chat.ru.md) · [Documentation](../README.md)

A server has text and voice channels. Default text/voice channels are protected against deletion. Administrators can add, rename and delete additional channels. **Deleting a text channel destroys its history and attachments** after confirmation; deleting an occupied voice channel disconnects active voice participants without deleting their server membership.

Text chats support messages, formatting, replies, images and navigation to replied-to messages. Read status and unread indicators belong to the client. You can browse chats while not in voice.

Permissions are server-wide in the current API 2 implementation: administrator, moderator and member. There are no private, role-restricted channels with separate encryption roots. A linked-device group shares its current profile/permissions and can edit its own messages, but only one linked device may join voice at once.

**Privacy:** messages/images are end-to-end encrypted. The server still sees metadata such as channel IDs, memberships, timing and traffic sizes. Previously obtained ciphertext and keys cannot be retracted by deleting a membership. [Security details](../../architecture/security.en.md).
