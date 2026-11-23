# Settings reference

[Русский](settings.ru.md) · [Documentation](../README.md)

PawTalk organizes settings by purpose:

| Area | Controls |
| --- | --- |
| Profile | Name and avatar |
| Audio and devices | Microphone/speaker selection, levels, mic test, input mode, PTT, RNNoise, echo cancellation and gain |
| Sounds | Notification on/off, volume and built-in sound previews |
| Appearance and chat | Theme/colors, font size, spacing and chat presentation |
| System | Launch on Windows sign-in, tray, keyboard shortcuts and Client updates |

Settings are stored locally; they are **not** Server Manager settings. A persistent Server's history size, address and update behavior are controlled by its Manager. The installed Client's version and Server/Manager versions are independent.

For most microphone issues, confirm OS permissions and device selection before changing manual sensitivity. For unsupported options or behavior differences, compare with the [published release notes](../../releases/README.md), not unfinished source changes.

## Profile and devices on API 3 servers

Open **Server settings → Profile and devices**. To connect another device to your profile, choose **Add a new device**. If you already have two profiles on this server, choose **Additional actions → Merge two existing profiles**. Before you confirm, you can review how many devices will move and which role assignments will be removed.

The linked-device list marks your current device as **This device**. The owner and administrators can select **Revoke access** for another device on their own profile. Other devices retain access. If the selected device signs server attestations, transfer signing first from **Server access → Transfer attestation signing**.

An avatar saved in the server profile settings synchronizes between that profile's linked devices. The server stores the avatar encrypted.

### Recovery kit

A recovery kit restores access to an active profile on a specific server after all linked devices have been lost, damaged, or reset. **Leave server** ends your membership and revokes the kit.

1. On a working device, go to **Server settings → Profile and devices → Access recovery** and create a kit.
2. Save the entire string in a secure note in your password manager. Label it with the server and profile names. Make sure you can open the password manager from another device.
3. Keep a separate copy of the same string, for example on an encrypted USB drive stored away from the computer. Treat the kit like a password and keep it out of chats and screenshots. **Copy kit** puts the string on the clipboard. Paste it into your chosen storage location.
4. Select **I saved the recovery kit**, confirm setup, and wait for the confirmation that recovery is ready.

On a new device, go to **Join a server → Lost access to all your devices?** and paste the saved kit. A successful recovery disconnects the profile's previous devices on that server.

If someone else gains access to your kit, create and confirm a replacement from a working device. If the server's address or certificate changes, update the address in the client first, then create a new kit. Save the new kit before confirming. After the replacement succeeds, update the backup copy and delete the old kit, which is now invalid.
