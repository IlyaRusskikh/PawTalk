# Working on Voicecord

- Keep the English `README.md` and Russian `README.ru.md` consistent when changing
  setup or user-visible features. Detailed existing documentation is in `docs/`.
- The original project is licensed `AGPL-3.0-only`. Preserve third-party notices.
- Do not commit secrets, real room invitations, local network reports, personal
  recordings, `CONTINUE.md`, `deploy/generated/`, downloaded tools or build output.
- Before publication run `npm run check:public` and review staged content.
  The guard is heuristic and does not replace reviewing the diff.
- Run checks appropriate to the change. Client baseline: `npm run build`,
  `npm test`. Go baseline inside `server`: `go test ./...`, `go vet ./...`.
  Audio and networking changes need relevant smoke/integration checks; distinguish
  synthetic checks from real-device and external-network verification.
- When asked to release, follow `docs/RELEASING.md`: X.Y.Z uses Z for small fixes,
  Y for substantial changes and X for very large changes. Reset lower components.
  Update both package manifests, CHANGELOG, and version-specific documentation.
  Start at 0.1.0. Do not bump versions for every work-in-progress edit.
- Local builds must not automatically publish. Release tags are `vX.Y.Z` and
  must match package metadata. Never replace published tags or binaries.
