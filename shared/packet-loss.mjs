// Weighted loss over the latest sampling interval. New/replaced RTP streams use
// their initial counters; late packet recovery never produces negative percentages.
export class PacketLossMeter {
  previous = new Map();
  reset() { this.previous.clear(); }
  sample(streams) {
    const next = new Map(); let received = 0, lost = 0;
    for (const stream of streams) {
      const current = { received: Math.max(0, stream.received || 0), lost: Math.max(0, stream.lost || 0) };
      const before = this.previous.get(stream.id);
      const reset = !before || current.received < before.received;
      received += reset ? current.received : current.received - before.received;
      lost += reset ? current.lost : Math.max(0, current.lost - before.lost);
      next.set(stream.id, current);
    }
    this.previous = next;
    return received + lost > 0 ? Math.min(100, lost / (received + lost) * 100) : 0;
  }
}
