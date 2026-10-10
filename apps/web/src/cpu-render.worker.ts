import { renderAnimationRowsAsync } from '@tabcloud/compute';
import type { FrameTask } from '@tabcloud/shared';

export type CpuWorkerRequest =
  | { type: 'render'; task: FrameTask; token: string; startRow: number; rowCount: number; dutyCycle: number }
  | { type: 'cancel'; token: string };
export type CpuWorkerResponse =
  | { type: 'progress'; token: string; rows: number }
  | { type: 'done'; token: string; pixels: ArrayBuffer; activeMs: number; elapsedMs: number }
  | { type: 'error'; token: string; message: string };

let active: { token: string; controller: AbortController } | null = null;

self.onmessage = async ({ data }: MessageEvent<CpuWorkerRequest>) => {
  if (data.type === 'cancel') {
    if (active?.token === data.token) active.controller.abort();
    return;
  }
  if (active) {
    self.postMessage({ type: 'error', token: data.token, message: 'Worker is already rendering a strip.' } satisfies CpuWorkerResponse);
    return;
  }
  const controller = new AbortController();
  active = { token: data.token, controller };
  const started = performance.now();
  let activeMs = 0;
  let lastProgress = started;
  try {
    const pixels = await renderAnimationRowsAsync(data.task, data.startRow, data.rowCount, {
      signal: controller.signal, dutyCycle: data.dutyCycle, rowsPerChunk: 8, targetChunkMs: 8,
      onActiveTime: (milliseconds) => { activeMs += milliseconds; },
      onProgress: (rows) => {
        if (performance.now() - lastProgress >= 200 || rows === data.rowCount) {
          lastProgress = performance.now();
          self.postMessage({ type: 'progress', token: data.token, rows } satisfies CpuWorkerResponse);
        }
      },
    });
    const buffer = pixels.buffer as ArrayBuffer;
    self.postMessage({ type: 'done', token: data.token, pixels: buffer, activeMs, elapsedMs: performance.now() - started } satisfies CpuWorkerResponse, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({ type: 'error', token: data.token, message: error instanceof Error ? error.message : 'Strip rendering failed.' } satisfies CpuWorkerResponse);
  } finally {
    if (active?.controller === controller) active = null;
  }
};
