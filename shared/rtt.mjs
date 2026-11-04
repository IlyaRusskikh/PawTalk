// RTT is only fresh when a new RTCP measurement arrives, not merely a new getStats report.
export class RttMeter {
  constructor(ttl = 15000) { this.ttl = ttl; this.reset(); }
  reset() { this.signature = undefined; this.measuredAt = -Infinity; this.rtt = undefined; }
  sample(stat, now = performance.now()) {
    if (!stat || !Number.isFinite(stat.roundTripTime) || stat.roundTripTime < 0) return this.value(now);
    const count = stat.roundTripTimeMeasurements;
    if (count === 0) return this.value(now);
    const signature = `${stat.id}:${count ?? stat.totalRoundTripTime ?? stat.roundTripTime}`;
    if (signature !== this.signature) { this.signature = signature; this.measuredAt = now; this.rtt = stat.roundTripTime * 1000; }
    return this.value(now);
  }
  value(now = performance.now()) { return now - this.measuredAt <= this.ttl ? this.rtt : undefined; }
}
