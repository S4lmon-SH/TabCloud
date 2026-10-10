import { renderAnimationFrameAsync } from '@tabcloud/compute';
import type { FrameTask } from '@tabcloud/shared';

export type AnimationWorkerResponse =
  | { type: 'progress'; token: string; rows: number }
  | { type: 'done'; token: string; pixels: ArrayBuffer; computeMs: number }
  | { type: 'error'; token: string; message: string };

self.onmessage = async ({ data }: MessageEvent<{ task: FrameTask; token: string }>) => {
  const started = performance.now();
  let lastProgress = 0;
  try {
    const pixels = await renderAnimationFrameAsync(data.task, {
      rowsPerChunk: 4,
      onProgress: (rows) => {
        if (performance.now() - lastProgress >= 900 || rows === data.task.settings.height) {
          lastProgress = performance.now();
          self.postMessage({ type: 'progress', token: data.token, rows } satisfies AnimationWorkerResponse);
        }
      },
    });
    const buffer = pixels.buffer as ArrayBuffer;
    self.postMessage({ type: 'done', token: data.token, pixels: buffer, computeMs: performance.now() - started } satisfies AnimationWorkerResponse, { transfer: [buffer] });
  } catch (err) { self.postMessage({ type: 'error', token: data.token, message: err instanceof Error ? err.message : 'Frame rendering failed.' } satisfies AnimationWorkerResponse); }
};
