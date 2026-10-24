export interface Settings { profile: string; raft: boolean; raftSplit?: boolean; patchGrid?: boolean; overhang: number; gap: number; name: string }
export interface Issue { severity: 'error' | 'warning' | 'info'; code: string; message: string }
export interface Summary {
  contacts: number; trees: number; plateZ: number; triangles: number;
  stats: Record<string, number>; timings: Record<string, number>;
  issues: Issue[]; exportNotes: string[]; supportWatertight: boolean; parts: string[];
}
export interface EngineResult { summary: Summary; output: Uint8Array; supports?: Uint8Array; raft?: Uint8Array }
export type WorkerRequest =
  | { type: 'generate'; id: string; revision: number; data: ArrayBuffer | {vertices:ArrayBuffer;indices:ArrayBuffer}; settings: Settings }
  | { type: 'export'; name: string; parts: { output: Uint8Array; lift: number }[] };
export type WorkerReply =
  | { type: 'progress'; fraction: number; message: string }
  | { type: 'result'; id: string; revision: number; result: EngineResult }
  | { type: 'exported'; output: Uint8Array }
  | { type: 'error'; message: string };
