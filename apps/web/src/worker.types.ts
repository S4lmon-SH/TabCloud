import type { TileTask } from '@tabcloud/shared';

export type WorkerRequest = { task: TileTask; token: string };
export type WorkerResponse =
  | { type: 'progress'; token: string; rows: number }
  | { type: 'done'; token: string; pixels: ArrayBuffer; computeMs: number }
  | { type: 'error'; token: string; message: string };
