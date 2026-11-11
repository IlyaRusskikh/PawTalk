# Third-party notices

PawTalk's original source is AGPL-3.0-only (see `LICENSE`). This does not
relicense third-party components. Preserve their notices when redistributing.
Pinned npm dependencies and their license identifiers are in `package-lock.json`;
their original license files are installed by `npm ci`.

## Desktop and UI

The Windows Server Manager bundles the official CPython 3.14.10 embeddable
runtime under the Python Software Foundation License and included third-party
terms. Its original `runtime/LICENSE.txt` is distributed unchanged. Source:
https://www.python.org/downloads/release/python-31410/.
The native Manager host uses Go and golang.org/x/sys (BSD-style licenses);
the installer includes `GO-LICENSE` and `X-SYS-LICENSE`. Server archives retain
Go/LiveKit notices separately from the desktop Client.

- Electron: MIT, plus Chromium and other component licenses. Packaged builds
  include `LICENSE.electron.txt` and `LICENSES.chromium.html` alongside the app.
  Source: https://github.com/electron/electron (version in `package-lock.json`).
- React / React DOM: Meta Platforms, Inc. and affiliates, MIT.
  Source: https://github.com/facebook/react (versions in `package-lock.json`).
- LiveKit JS client: LiveKit, Inc. and contributors, Apache License 2.0.
  Source: https://github.com/livekit/client-sdk-js (version in `package-lock.json`).
- Transitive JavaScript components retain their licenses and notices in the
  packaged dependency tree. The frontend notices are also in `licenses/npm-runtime.txt`.

## RNNoise audio processing

PawTalk includes the default RNNoise neural model and WebAssembly code from
`@shiguredo/rnnoise-wasm` 2025.1.5, generated from the package at build time.
The JavaScript audio adapter and streaming pipeline in `shared/` are PawTalk code.

- RNNoise: Xiph.Org Foundation and contributors; BSD 3-clause. See `licenses/RNNoise.BSD.txt`.
- rnnoise-wasm build/wrapper: Copyright 2021–2025 Takeru Ohta and Shiguredo Inc.; Apache License 2.0. See `licenses/rnnoise-wasm.APACHE2.txt`.
- Upstream: https://github.com/xiph/rnnoise and https://github.com/shiguredo/rnnoise-wasm.

The build script extracts the embedded WASM unchanged; it does not modify the model.
The original browser wrapper is not executed in the AudioWorklet.
No endorsement or affiliation with Krisp or Discord is implied.

## Embedded server and port mapping

- LiveKit Server 1.13.11: LiveKit, Inc. and contributors, Apache License 2.0. The official Windows binary and `server/LIVEKIT-LICENSE` are bundled as resources. Upstream: https://github.com/livekit/livekit.
- `@silentbot1/nat-api` 0.4.9: Brad Marsden and contributors, MIT. See `licenses/nat-api.MIT.txt`. Used for temporary UPnP and NAT-PMP mappings.
- Go runtime and standard library: The Go Authors, BSD 3-clause. See the bundled `server/GO-LICENSE`.
- SQLite and its Go driver (`modernc.org/sqlite`) store the chat ciphertext. See `licenses/go-runtime.txt` for their notices and those of the Go dependencies pinned in `server/go.mod`.

## Notification recordings

All seven notification recordings are edits of works by **Joseph SARDIN /
BigSoundBank**, dedicated under **CC0 1.0 Universal**:

- Join (approved variant B): https://bigsoundbank.com/meow-cat-13-s1901.html.
- Leave (approved variant A): https://bigsoundbank.com/meow-cat-2-s1890.html.
- Five purrs: https://bigsoundbank.com/cat-purr-s0436.html.

License: https://creativecommons.org/publicdomain/zero/1.0/.
Asset-specific provenance and checksums are bundled in `sounds/sources.json`
and `sounds/README.md`. The earlier user-provided meows are no longer used.

## Corresponding source

Release publishers must link the exact PawTalk source tag alongside each binary
and preserve upstream sources/notices for embedded components. LiveKit Server
source for the bundled version: https://github.com/livekit/livekit/tree/v1.13.11.
The npm lockfile and preparation scripts record reproducible dependency versions;
build instructions are in both root READMEs. Local recordings, credentials and
server keys are not part of corresponding source.
