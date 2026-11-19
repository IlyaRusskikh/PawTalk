# 009 — Measure Client installer sources before continuing download

Status: accepted for the current working implementation; no release implied.

Context: GitHub can deliver bytes slowly without failing. Sequential fallback
waits for the slow-transfer threshold and never compares healthy room relays.

Decision: sample GitHub first, then probe configured relays with bounded
concurrency. Retain the fastest measured stream and its prefix, cancel the others,
and continue without requesting the winning artifact a second time. Complete
verified artifacts finish immediately. Retry transport failures by excluding the
failed source and measuring the remaining sources within one overall deadline.
Keep discovery/signing authority, pinned room preparation, signed artifact size,
SHA-256, freshness, channel and version checks. Observed integrity failures remain
fatal. Server GET relay contracts and Manager behavior remain unchanged.

Alternatives: raising the sequential timeout leaves slow downloads unchanged;
downloading every complete installer wastes bandwidth; Range probes require new
relay contracts and still discard the sampled connection. No new dependency is
required for retained WHATWG readers and AbortController cancellation.

Consequences: probing consumes bounded extra bytes and temporary connections.
Room cold-cache latency contributes to measured speed. A short sample estimates
current throughput rather than guaranteeing sustained performance; existing
stall/slow-window checks remain active. At most two probes plus the current best
stream are retained. Limits are documented in [updates](../../architecture/updates.en.md).

Verification: synthetic local HTTP streams cover fastest-source selection,
single-request continuation, loser cancellation, offline/stalled sources and
corrupt fastest bytes. Existing signed updater tests retain fail-closed and
helper-launch coverage. External GitHub/room bandwidth is not a local benchmark.
