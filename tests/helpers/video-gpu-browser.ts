import { createVideoGpuProcessor, probeVideoGpu, type VideoGpuProcessor } from '../../apps/web/src/video-gpu';
import { processVideoFrame } from '../../packages/compute/src/video';
import { DEFAULT_VIDEO_PROCESSING, type VideoFrameTask, type VideoProcessingSettings } from '../../packages/shared/src/video';

function source(width: number, height: number, seed: number): Uint8ClampedArray {
  return Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => (index * 73 + Math.floor(index / 4) * 37 + seed * 17) % 256);
}

/** Browser-only harness bundled by Playwright; never imported by application code. */
export async function checkVideoGpu() {
  const support = await probeVideoGpu();
  if (!support.available) return { available: false as const, reason: support.reason };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  let deviceCreations = 0;
  GPUAdapter.prototype.requestDevice = function (descriptor) {
    deviceCreations += 1;
    return requestDevice.call(this, descriptor);
  };
  let gpu: VideoGpuProcessor | null = null;
  const neutral: VideoProcessingSettings = { denoise: 0, denoiseRadius: 1, sharpen: 0, brightness: 0, contrast: 100, saturation: 100 };
  const configurations: { width: number; height: number; settings: VideoProcessingSettings }[] = [
    { width: 2, height: 2, settings: { denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: -50, contrast: 50, saturation: 0 } },
    { width: 17, height: 9, settings: neutral },
    { width: 17, height: 9, settings: { denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: 50, contrast: 150, saturation: 200 } },
    { width: 1280, height: 720, settings: { ...DEFAULT_VIDEO_PROCESSING } },
    { width: 1280, height: 720, settings: { denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: -17, contrast: 137, saturation: 173 } },
    { width: 1920, height: 1080, settings: { ...DEFAULT_VIDEO_PROCESSING } },
    { width: 1080, height: 1920, settings: { denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: 13, contrast: 121, saturation: 147 } },
  ];
  const measurements: { width: number; height: number; settings: VideoProcessingSettings; frameIndex: number;
    maxDifference: number; processedBytes: number; dispatches: number; busyMs: number; timestampMs: number | null; allocatedBytes: number }[] = [];
  try {
    gpu = await createVideoGpuProcessor();
    if (!gpu) return { available: false as const, reason: 'GPU device creation failed.' };
    for (let frameIndex = 0; frameIndex < configurations.length; frameIndex++) {
      const config = configurations[frameIndex]!;
      const task: VideoFrameTask = { ...config, jobId: 'gpu-video-parity', taskId: `frame:${frameIndex}`, frameIndex, algorithmVersion: 'video-filter-v1' };
      const input = source(config.width, config.height, frameIndex);
      const expected = processVideoFrame(input, task);
      gpu.beginFrame(input, task);
      let maxDifference = 0; let dispatches = 0; let busyMs = 0; let timestampMs: number | null = null;
      for (let row = 0; row < task.height; row += 64) {
        const result = await gpu.renderStrip(row, Math.min(64, task.height - row));
        dispatches++; busyMs += result.busyMs;
        if (result.timestampMs !== null) timestampMs = (timestampMs ?? 0) + result.timestampMs;
        for (let byte = 0; byte < result.pixels.length; byte++) {
          maxDifference = Math.max(maxDifference, Math.abs(result.pixels[byte]! - expected[row * task.width * 4 + byte]!));
        }
      }
      measurements.push({ ...config, frameIndex, maxDifference, processedBytes: expected.length,
        dispatches, busyMs, timestampMs, allocatedBytes: gpu.allocatedBytes });
    }
    const controller = new AbortController();
    const pending = gpu.renderStrip(0, 64, { signal: controller.signal }); controller.abort();
    let abortName = '';
    try { await pending; } catch (error) { abortName = error instanceof Error ? error.name : String(error); }
    return { available: true as const, adapterName: gpu.adapterName, hardware: gpu.hardware,
      timestampSupported: gpu.timestampSupported, deviceCreations, measurements, abortName, lostAfterAbort: gpu.lost };
  } finally { gpu?.destroy(); GPUAdapter.prototype.requestDevice = requestDevice; }
}
