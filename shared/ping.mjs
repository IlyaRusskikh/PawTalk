// Both the profile and participant cards use the same RTT thresholds.
export function pingLevel(rtt) {
  if (!Number.isFinite(rtt) || rtt < 0) return 'unknown';
  if (rtt >= 300) return 'bad';
  if (rtt >= 150) return 'warning';
  return 'good';
}
