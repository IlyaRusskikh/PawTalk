export class RtcDiagnosticsMeter {
  reset(): void;
  sample(report?: RTCStatsReport, now?: number): Record<string, number | string | undefined>;
}
