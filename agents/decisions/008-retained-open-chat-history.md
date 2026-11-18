# 008 — Retain open-chat history, paginate automatically

Status: implemented in development source; no release/publication is implied.

Context: a rolling 25–500-message window evicted the opposite end while scrolling and exposed manual previous/next buttons. The preference should determine request size, not cache capacity.

Decision: keep contiguous history blocks in the open chat's RAM cache, automatically fetch boundaries, preserve disjoint reply/latest blocks, and patch cached data from WS. Keep HTTP initial/history/recovery requests bounded. Release on chat unmount or real system/heap pressure, preserving a neighborhood around the viewport. Keep image decoding on its existing lazy lifecycle. Initial entry uses the latest batch unless restoring an explicit saved position.

Consequences: no new production dependency or API/schema change. Cache/DOM size can grow while memory is available; pressure checks are local and do not poll Server. Synthetic pressure tests validate reclamation without forcing the workstation into low memory. Public Discord pagination informs the request pattern, not an asserted copy of its private cache policy. See architecture/chat-features.en.md and its Russian counterpart.
