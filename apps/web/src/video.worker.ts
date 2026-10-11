import type { VideoFrameTask } from '@tabcloud/shared';
import type { DeviceResources, ResourceLimits } from './resource-budget';
import { createVideoProcessor, type VideoRenderStats } from './video-renderer';

export type VideoWorkerRequest =
  | { type: 'render'; token: string; task: VideoFrameTask; pixels: ArrayBuffer; limits: ResourceLimits; device: DeviceResources }
  | { type: 'cancel'; token: string };
export type VideoWorkerResponse =
  | { type: 'progress'; token: string; rows: number; stats: VideoRenderStats }
  | { type: 'done'; token: string; pixels: ArrayBuffer; computeMs: number; stats: VideoRenderStats }
  | { type: 'error'; token: string; message: string };

const processor = createVideoProcessor();
let active: { token: string; controller: AbortController } | null = null;
self.onmessage = async ({ data }: MessageEvent<VideoWorkerRequest>) => {
  if (data.type === 'cancel') { if (active?.token === data.token) active.controller.abort(); return; }
  if (active) { self.postMessage({ type: 'error', token: data.token, message: 'A video frame is already processing.' } satisfies VideoWorkerResponse); return; }
  const controller = new AbortController(); active = { token: data.token, controller };
  let lastProgress = 0;
  try {
    const result = await processor.processFrame(new Uint8ClampedArray(data.pixels), data.task, data.limits, data.device, {
      signal: controller.signal,
      onProgress: (rows, stats) => {
        if (performance.now() - lastProgress >= 500 || rows === data.task.height) {
          lastProgress = performance.now();
          self.postMessage({ type: 'progress', token: data.token, rows, stats } satisfies VideoWorkerResponse);
        }
      },
    });
    const pixels = result.pixels.buffer as ArrayBuffer;
    self.postMessage({ type: 'done', token: data.token, pixels, computeMs: result.elapsedMs, stats: result.stats } satisfies VideoWorkerResponse, { transfer: [pixels] });
  } catch (error) {
    self.postMessage({ type: 'error', token: data.token, message: error instanceof Error ? error.message : 'Video processing failed.' } satisfies VideoWorkerResponse);
  } finally { if (active?.controller === controller) active = null; }
};
