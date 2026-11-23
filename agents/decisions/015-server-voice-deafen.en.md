# 015. Server voice deafen and media keys

[Русский](015-server-voice-deafen.ru.md)

Server mic mute and server deafen change LiveKit permissions. Deafen disables both publishing and subscribing. The member stays in the verified voice key roster. The decision trades cryptographic key exclusion for stable audio and fewer key exchanges during moderation. Removing a member or revoking channel access still changes key eligibility.

New servers advertise `protectedVoiceMediaDeafen`. Updated clients express this operation in signed policy mode `server-media`. Earlier `server` deafen records retain their key-exclusion behavior, so historical snapshots and attestations stay verifiable. The heartbeat can retain an installed key through moderation-only revisions with the same verified recipient digest. LiveKit must still acknowledge permission changes before the server extends a stale media lease.

The two-client `--voice-moderation` smoke checks permission transitions and key continuity. `--voice-deafen-sustained` covers legacy key exclusion and admission after lifting it.
