export interface HistoryPoint { at: number; value: number | undefined }
export interface HistorySnapshot { state: string; at: number; rtt: HistoryPoint[]; loss: HistoryPoint[] }
export const historyWindow: number;
export class ConnectionHistory {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HistorySnapshot;
  reset(state?: string, at?: number): void;
  setState(state: string, at?: number): void;
  sample(input?: { at?: number; state?: string; rtt?: number; rttAt?: number; loss?: number }): void;
}
export function chartSegments(points: HistoryPoint[], now: number, maximum: number, width?: number, height?: number): number[][][];
