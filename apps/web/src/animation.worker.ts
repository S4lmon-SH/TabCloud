import type { FrameTask } from '@tabcloud/shared';
import type { DeviceResources, ResourceLimits } from './resource-budget';
import { renderResourceFrame, type ResourceRenderStats } from './resource-renderer';

export type AnimationWorkerRequest = { task: FrameTask; token: string; limits: ResourceLimits; device: DeviceResources }
  | { type: 'cancel'; token: string };

export type AnimationWorkerResponse =
  | { type: 'progress'; token: string; rows: number; stats: ResourceRenderStats }
  | { type: 'done'; token: string; pixels: ArrayBuffer; computeMs: number; stats: ResourceRenderStats }
  | { type: 'error'; token: string; message: string };

let active: { token: string; controller: AbortController } | null = null;

self.onmessage = async ({ data }: MessageEvent<AnimationWorkerRequest>) => {
  if ('type' in data && data.type === 'cancel') {
    if (active?.token === data.token) active.controller.abort();
    return;
  }
  if (!('task' in data)) return;
  if (active) {
    self.postMessage({ type: 'error', token: data.token, message: 'A frame is already rendering.' } satisfies AnimationWorkerResponse);
    return;
  }
  const controller = new AbortController();
  active = { token: data.token, controller };
  let lastProgress = 0;
  try {
    const result = await renderResourceFrame(data.task, data.limits, data.device, {
      signal: controller.signal,
      onProgress: (rows, stats) => {
        if (performance.now() - lastProgress >= 900 || rows === data.task.settings.height) {
          lastProgress = performance.now();
          self.postMessage({ type: 'progress', token: data.token, rows, stats } satisfies AnimationWorkerResponse);
        }
      },
    });
    const buffer = result.pixels.buffer as ArrayBuffer;
    self.postMessage({ type: 'done', token: data.token, pixels: buffer, computeMs: result.elapsedMs, stats: result.stats } satisfies AnimationWorkerResponse, { transfer: [buffer] });
  } catch (err) {
    self.postMessage({ type: 'error', token: data.token, message: err instanceof Error ? err.message : 'Frame rendering failed.' } satisfies AnimationWorkerResponse);
  } finally {
    if (active?.controller === controller) active = null;
  }
};
