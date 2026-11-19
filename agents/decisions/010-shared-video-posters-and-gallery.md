# 010 — Sender-generated video posters and encrypted media galleries

Status: accepted for the current working implementation.

Context: native video controls differ from the requested messenger interface.
Extracting a frame separately on each receiving device wastes downloads/decoding
and gives inconsistent thumbnails. One message must support several videos.

Decision: generate a bounded JPEG poster on the sending Client from the first
nonempty opening frame, retaining aspect ratio and original video bytes. Encrypt
the poster through the existing attachment image path and bind it atomically with
the video. Introduce `media-gallery-v1` for up to ten encrypted file entries and
twenty unique bound attachment IDs. Preserve legacy single-image/file decoding.
Retries compare full attachment sets; device/channel ownership and storage quotas
remain mandatory. Twenty pending parts expire after thirty minutes. No numeric
API/data schema, new production dependency or Manager contract change is needed.

Render saved posters lazily. A custom modal viewer owns one video element,
provides playback/seek/0–200% gain, and uses the Fullscreen API on its container so
the native monitor fullscreen retains custom controls. Navigation is limited to
videos in that message. Draft cards provide preview, rename and removal.

Alternatives: server-side frame extraction breaks mandatory E2EE; embedding video
or large image bytes in chat ciphertext exceeds bounded message envelopes;
receiver-side extraction repeats work; separate messages lose grouped navigation.

Verification: real Electron synthetic videos exercise nonempty-frame selection,
draft cards, shared poster references, autoplay, navigation, hover volume, controls
hiding and actual native fullscreen/Escape. Crypto tests inspect authenticated
gallery content and capability rejection. Go tests cover twenty-part binding,
atomic failure, duplicate IDs, set-based idempotency and pending-upload bounds.
External hardware/codecs remain separate from these synthetic fixtures.
