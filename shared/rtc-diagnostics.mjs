// Derived solely from the report already collected by VoiceSession.
export class RtcDiagnosticsMeter {
  previous = undefined;
  feedback = undefined;
  reset() { this.previous = undefined; this.feedback = undefined; }
  sample(report, now = performance.now()) {
    const stats = [...(report?.values() ?? [])];
    const outgoing = stats.find(stat => stat.type === 'outbound-rtp' && stat.kind === 'audio');
    const transport = stats.find(stat => stat.type === 'transport' && stat.selectedCandidatePairId);
    const pair = stats.find(stat => stat.id === transport?.selectedCandidatePairId)
      ?? stats.find(stat => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated);
    const candidate = stats.find(stat => stat.id === pair?.localCandidateId);
    const codec = stats.find(stat => stat.id === outgoing?.codecId);
    const source = stats.find(stat => stat.id === outgoing?.mediaSourceId);
    const remote = outgoing && stats.find(stat => stat.type === 'remote-inbound-rtp' && (stat.localId === outgoing.id || (outgoing.remoteId && stat.id === outgoing.remoteId)));
    // RTCP fractionLost covers the receiver's reporting interval. Local sent
    // counters can be ahead of that report, so do not divide mismatched deltas.
    const feedbackStamp = Number.isFinite(remote?.timestamp) ? remote.timestamp : remote?.roundTripTimeMeasurements > 0 ? remote.roundTripTimeMeasurements : undefined;
    const validFeedback = remote && Number.isFinite(feedbackStamp) && Number.isFinite(remote.fractionLost) && remote.fractionLost >= 0 && remote.fractionLost <= 1;
    if (validFeedback) {
      const signature = `${outgoing.id}:${outgoing.ssrc}:${remote.id}:${feedbackStamp}`;
      if (signature !== this.feedback?.signature) this.feedback = { signature, at: now, loss: remote.fractionLost * 100 };
    }
    const outgoingLoss = validFeedback && this.feedback && now - this.feedback.at <= 15000 ? this.feedback.loss : undefined;
    const previous = this.previous;
    this.previous = outgoing;
    const elapsed = outgoing && previous && outgoing.id === previous.id ? (outgoing.timestamp - previous.timestamp) / 1000 : 0;
    const delta = key => elapsed > 0 && Number.isFinite(outgoing[key]) && Number.isFinite(previous[key]) && outgoing[key] >= previous[key] ? outgoing[key] - previous[key] : undefined;
    const bytes = delta('bytesSent');
    return {
      availableBitrate: pair?.availableOutgoingBitrate,
      transportPacketsReceived: pair?.packetsReceived ?? transport?.packetsReceived, transportPacketsSent: pair?.packetsSent ?? transport?.packetsSent,
      transportBytesReceived: pair?.bytesReceived ?? transport?.bytesReceived, transportBytesSent: pair?.bytesSent ?? transport?.bytesSent,
      localAddress: candidate?.address, protocol: candidate?.protocol,
      ssrc: outgoing?.ssrc, codec: codec?.mimeType, sampleRate: codec?.clockRate,
      audioDetected: Number.isFinite(source?.audioLevel) ? (source.audioLevel > 0 ? 'yes' : 'no') : undefined,
      audioLevel: source?.audioLevel,
      bitrate: bytes === undefined ? undefined : bytes * 8 / elapsed,
      targetBitrate: outgoing?.targetBitrate,
      bytesSent: outgoing?.bytesSent, packetsSent: outgoing?.packetsSent,
      packetsLost: remote?.packetsLost,
      outgoingLoss,
    };
  }
}
