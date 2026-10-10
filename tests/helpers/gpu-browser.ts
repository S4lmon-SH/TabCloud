import { createGpuRenderer } from '../../apps/web/src/gpu-renderer';
import { renderAnimationFrame } from '../../packages/compute/src/animation';
import type { AnimationSettings, FrameTask } from '../../packages/shared/src/animation';

/** Bundled only by the browser test; no test/debug route is shipped in the application. */
export async function checkGpuParity() {
  const renderer = await createGpuRenderer();
  if (!renderer) return { available: false as const };
  const cases: { settings: AnimationSettings; frameIndex: number }[] = [
    ...[0, 3, 7, 11].map((frameIndex) => ({
      settings: { width: 128, height: 72, frames: 12, fps: 24 as const, samples: 32, bounces: 4 }, frameIndex,
    })),
    { settings: { width: 320, height: 180, frames: 12, fps: 24, samples: 8, bounces: 3 }, frameIndex: 11 },
    { settings: { width: 1280, height: 720, frames: 120, fps: 24, samples: 8, bounces: 3 }, frameIndex: 0 },
  ];
  const measurements: { width: number; height: number; samples: number; frameIndex: number; maxDifference: number; correctedPixels: number; pixelCount: number }[] = [];
  try {
    for (const { settings, frameIndex } of cases) {
      const task: FrameTask = { jobId: 'gpu-parity', taskId: `frame-${settings.width}-${frameIndex}`, frameIndex, settings, algorithmVersion: 'raytrace-v1' };
      const expected = renderAnimationFrame(task);
      let maxDifference = 0;
      let correctedPixels = 0;
      for (let row = 0; row < settings.height; row += 8) {
        const result = await renderer.renderStrip(task, row, Math.min(8, settings.height - row));
        correctedPixels += result.correctedPixels;
        for (let index = 0; index < result.pixels.length; index += 1) {
          maxDifference = Math.max(maxDifference, Math.abs(result.pixels[index]! - expected[row * settings.width * 4 + index]!));
        }
      }
      measurements.push({ width: settings.width, height: settings.height, samples: settings.samples, frameIndex,
        maxDifference, correctedPixels, pixelCount: settings.width * settings.height });
    }
    const task: FrameTask = { jobId: 'cancel', taskId: 'cancel', frameIndex: 0, algorithmVersion: 'raytrace-v1', settings: cases[0]!.settings };
    const controller = new AbortController();
    const pending = renderer.renderStrip(task, 0, 8, { signal: controller.signal });
    controller.abort();
    let abortName = '';
    try { await pending; } catch (error) { abortName = error instanceof Error ? error.name : String(error); }
    return { available: true as const, label: renderer.label, isFallbackAdapter: renderer.isFallbackAdapter,
      measurements, abortName, lostAfterAbort: renderer.lost };
  } finally {
    renderer.destroy();
  }
}
