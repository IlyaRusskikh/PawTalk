export const historyWindow = 120000;

// Local-only immutable snapshots. Audio-meter renders never add measurements.
export class ConnectionHistory {
  listeners = new Set();
  snapshot = { state: 'disconnected', at: 0, rtt: [], loss: [] };
  lastRttAt = undefined;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  publish(snapshot) { this.snapshot = snapshot; this.listeners.forEach(listener => listener()); }
  reset(state = 'disconnected', at = performance.now()) {
    this.lastRttAt = undefined;
    this.publish({ state, at, rtt: [], loss: [] });
  }
  setState(state, at = performance.now()) {
    if (state === this.snapshot.state) return;
    if (state === 'disconnected' || state === 'connecting') { this.reset(state, at); return; }
    this.sample({ at, state }); // A reconnect is an explicit break in both lines.
  }
  sample({ at = performance.now(), state = this.snapshot.state, rtt, rttAt, loss } = {}) {
    const valid = value => Number.isFinite(value) && value >= 0;
    const append = (series, value, stamp = at) => [...series.filter(point => point.at >= at - historyWindow), { at: stamp, value }].slice(-256);
    let rtts = this.snapshot.rtt.filter(point => point.at >= at - historyWindow);
    if (state !== 'connected' || !valid(rtt) || !Number.isFinite(rttAt) || at - rttAt > 15000 || rttAt > at) {
      rtts = append(rtts, undefined);
    } else if (rttAt !== this.lastRttAt) {
      rtts = append(rtts, rtt, rttAt);
      this.lastRttAt = rttAt;
    }
    this.publish({ state, at, rtt: rtts, loss: append(this.snapshot.loss, state === 'connected' && valid(loss) && loss <= 100 ? loss : undefined) });
  }
}

// Separate segments for missing data and unexpectedly long polling gaps.
export function chartSegments(points, now, maximum, width = 280, height = 58) {
  const segments = []; let segment = []; let previous;
  for (const point of points) {
    if (point.at < now - historyWindow || point.at > now) continue;
    if (!Number.isFinite(point.value) || (previous !== undefined && point.at - previous > 15000)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (Number.isFinite(point.value)) segment.push([width * (1 - (now - point.at) / historyWindow), height * (1 - Math.min(maximum, point.value) / maximum)]);
    previous = point.at;
  }
  if (segment.length) segments.push(segment);
  return segments;
}
