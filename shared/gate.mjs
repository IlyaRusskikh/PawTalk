// Hysteresis and hangover keep quiet syllables from being clipped.
export class VoiceGate {
  noise = -65;
  openUntil = 0;
  mode = '';
  speechFrames = 0;
  reset() { this.noise = -65; this.openUntil = 0; this.mode = ''; this.speechFrames = 0; }
  getThreshold(settings) {
    if (!settings.autoSensitivity) return settings.threshold;
    return settings.noiseMode === 'rnnoise' ? Math.max(-72, Math.min(-40, this.noise + 6)) : Math.max(-60, Math.min(-30, this.noise + 12));
  }
  update(db, now, settings, ptt, muted, speechProbability) {
    if (this.mode !== settings.inputMode) { this.openUntil = 0; this.mode = settings.inputMode; this.speechFrames = 0; }
    if (muted) { this.openUntil = 0; this.speechFrames = 0; return false; }
    if (settings.inputMode === 'ptt') {
      if (ptt) this.openUntil = now + settings.pttReleaseMs;
      return ptt || now < this.openUntil;
    }
    if (db < this.noise + 8 && (speechProbability === undefined || speechProbability < 0.2)) this.noise = this.noise * 0.985 + db * 0.015;
    else this.noise = Math.min(-35, this.noise + 0.006);
    const threshold = this.getThreshold(settings);
    const holding = now < this.openUntil;
    const speech = speechProbability === undefined || speechProbability >= (holding ? 0.25 : 0.55);
    const above = speech && db >= threshold - (holding ? 3 : 0);
    this.speechFrames = above ? this.speechFrames + 1 : 0;
    if (above && (speechProbability === undefined || holding || this.speechFrames >= 2)) this.openUntil = now + (speechProbability === undefined ? 220 : 300);
    return now < this.openUntil;
  }
}
