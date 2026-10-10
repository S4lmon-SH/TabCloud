/// <reference lib="webworker" />
import { renderTileAsync } from '@tabcloud/compute';
import type { WorkerRequest, WorkerResponse } from './worker.types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const started = performance.now();
  try {
    const pixels = await renderTileAsync(data.task, {
      rowsPerChunk: 8,
      onProgress: (rows) => scope.postMessage({ type: 'progress', token: data.token, rows } satisfies WorkerResponse),
    });
    const message: WorkerResponse = {
      type: 'done', token: data.token,
      pixels: pixels.buffer as ArrayBuffer, computeMs: performance.now() - started,
    };
    scope.postMessage(message, [message.pixels]);
  } catch (error) {
    scope.postMessage({ type: 'error', token: data.token, message: error instanceof Error ? error.message : '연산 오류' } satisfies WorkerResponse);
  }
};
