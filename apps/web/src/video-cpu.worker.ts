import { assertVideoInput, processVideoRowsAsync } from '@tabcloud/compute';
import type { VideoFrameTask } from '@tabcloud/shared';

export type VideoCpuRequest =
  | { type: 'initialize'; token: string; task: VideoFrameTask; pixels: ArrayBuffer }
  | { type: 'render'; token: string; startRow: number; rowCount: number; dutyCycle: number }
  | { type: 'cancel'; token: string }
  | { type: 'release' };
export type VideoCpuResponse =
  | { type: 'ready'; token: string }
  | { type: 'progress'; token: string; rows: number }
  | { type: 'done'; token: string; pixels: ArrayBuffer; activeMs: number }
  | { type: 'error'; token: string; message: string };

let frame: { task: VideoFrameTask; input: Uint8ClampedArray } | null = null;
let active: { token: string; controller: AbortController } | null = null;
self.onmessage = async ({ data }: MessageEvent<VideoCpuRequest>) => {
  if (data.type === 'release') { if (!active) frame = null; return; }
  if (data.type === 'cancel') { if (active?.token === data.token) active.controller.abort(); return; }
  if (active) {
    self.postMessage({ type: 'error', token: data.token, message: 'CPU video strip is already running.' } satisfies VideoCpuResponse);
    return;
  }
  if (data.type === 'initialize') {
    try {
      const input = new Uint8ClampedArray(data.pixels);
      assertVideoInput(input, data.task);
      frame = { input, task: data.task };
      self.postMessage({ type: 'ready', token: data.token } satisfies VideoCpuResponse);
    } catch (error) {
      frame = null;
      self.postMessage({ type: 'error', token: data.token, message: error instanceof Error ? error.message : 'Invalid video input.' } satisfies VideoCpuResponse);
    }
    return;
  }
  const controller = new AbortController();
  active = { token: data.token, controller };
  try {
    if (!frame) throw new Error('No video frame is loaded in the CPU Worker.');
    const result = await processVideoRowsAsync(frame.input, frame.task, data.startRow, data.rowCount, {
      dutyCycle: data.dutyCycle, signal: controller.signal, rowsPerChunk: 8,
      onProgress: (rows) => self.postMessage({ type: 'progress', token: data.token, rows } satisfies VideoCpuResponse),
    });
    const pixels = result.pixels.buffer as ArrayBuffer;
    self.postMessage({ type: 'done', token: data.token, pixels, activeMs: result.activeMs } satisfies VideoCpuResponse, { transfer: [pixels] });
  } catch (error) {
    self.postMessage({ type: 'error', token: data.token, message: error instanceof Error ? error.message : 'Video processing failed.' } satisfies VideoCpuResponse);
  } finally { if (active?.controller === controller) active = null; }
};
