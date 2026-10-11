import { isSupportedVideoDimensions, type VideoFrameTask, type VideoProcessingSettings } from '@tabcloud/shared';

type Bytes = Uint8Array | Uint8ClampedArray;
type Pixel = [number, number, number, number];

/** Round signed integer ratios to nearest, with ties away from zero (same rule in WGSL). */
const rounded = (value: number, denominator: number) => value >= 0
  ? Math.floor((value + Math.floor(denominator / 2)) / denominator)
  : -Math.floor((-value + Math.floor(denominator / 2)) / denominator);
const clamp = (value: number) => Math.max(0, Math.min(255, value));
const luma = (r: number, g: number, b: number) => (77 * r + 150 * g + 29 * b + 128) >>> 8;

export function assertVideoInput(input: Bytes, task: VideoFrameTask): void {
  const settings = task.settings;
  if (task.algorithmVersion !== 'video-filter-v1' || !isSupportedVideoDimensions(task.width, task.height)
    || !Number.isInteger(task.frameIndex) || task.frameIndex < 0 || input.byteLength !== task.width * task.height * 4
    || !Number.isInteger(settings.denoise) || settings.denoise < 0 || settings.denoise > 100
    || !Number.isInteger(settings.denoiseRadius) || settings.denoiseRadius < 1 || settings.denoiseRadius > 4
    || !Number.isInteger(settings.sharpen) || settings.sharpen < 0 || settings.sharpen > 100
    || !Number.isInteger(settings.brightness) || settings.brightness < -50 || settings.brightness > 50
    || !Number.isInteger(settings.contrast) || settings.contrast < 50 || settings.contrast > 150
    || !Number.isInteger(settings.saturation) || settings.saturation < 0 || settings.saturation > 200) {
    throw new RangeError('Unsupported video frame or processing settings.');
  }
}

/**
 * video-filter-v1: integer edge-aware blur plus a separate 3x3 Gaussian detail kernel,
 * followed by color adjustment. Noise removal and sharpening do not cancel each other.
 * Clamped border sampling and integer intermediates make the CPU and GPU byte-identical.
 * Maximum weighted color sum is below 2^31, including radius 4 and full-white input.
 */
function pixel(input: Bytes, width: number, height: number, settings: VideoProcessingSettings, x: number, y: number): Pixel {
  const offset = (y * width + x) * 4;
  const red = input[offset]!; const green = input[offset + 1]!; const blue = input[offset + 2]!;
  let blurR = red; let blurG = green; let blurB = blue;
  let detailR = red; let detailG = green; let detailB = blue;
  if (settings.denoise > 0 || settings.sharpen > 0) {
    const centerLuma = luma(red, green, blue);
    const radius = settings.denoiseRadius;
    let weightedR = 0; let weightedG = 0; let weightedB = 0; let weights = 0;
    let gaussianR = 0; let gaussianG = 0; let gaussianB = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const sy = Math.max(0, Math.min(height - 1, y + dy));
      for (let dx = -radius; dx <= radius; dx += 1) {
        const sx = Math.max(0, Math.min(width - 1, x + dx));
        const sample = (sy * width + sx) * 4;
        const r = input[sample]!; const g = input[sample + 1]!; const b = input[sample + 2]!;
        if (settings.sharpen > 0 && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
          const gaussian = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
          gaussianR += r * gaussian; gaussianG += g * gaussian; gaussianB += b * gaussian;
        }
        const difference = Math.abs(luma(r, g, b) - centerLuma);
        const weight = Math.max(1, 256 - difference * 4) * (radius + 1 - Math.abs(dx)) * (radius + 1 - Math.abs(dy));
        weightedR += r * weight; weightedG += g * weight; weightedB += b * weight; weights += weight;
      }
    }
    blurR = rounded(weightedR, weights); blurG = rounded(weightedG, weights); blurB = rounded(weightedB, weights);
    if (settings.sharpen > 0) {
      detailR = rounded(gaussianR, 16); detailG = rounded(gaussianG, 16); detailB = rounded(gaussianB, 16);
    }
  }
  const adjustment = (channel: number, blur: number, detail: number) => {
    const filtered = clamp(rounded(channel * (100 - settings.denoise) + blur * settings.denoise, 100)
      + rounded((channel - detail) * settings.sharpen, 100));
    return clamp(rounded((filtered - 128) * settings.contrast, 100) + 128 + rounded(settings.brightness * 255, 100));
  };
  const r = adjustment(red, blurR, detailR); const g = adjustment(green, blurG, detailG); const b = adjustment(blue, blurB, detailB);
  const gray = luma(r, g, b);
  return [clamp(gray + rounded((r - gray) * settings.saturation, 100)),
    clamp(gray + rounded((g - gray) * settings.saturation, 100)),
    clamp(gray + rounded((b - gray) * settings.saturation, 100)), input[offset + 3]!];
}

export function processVideoPixel(input: Bytes, task: VideoFrameTask, x: number, y: number): Pixel {
  assertVideoInput(input, task);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= task.width || y >= task.height) {
    throw new RangeError('Pixel lies outside the video frame.');
  }
  return pixel(input, task.width, task.height, task.settings, x, y);
}

function validateRows(task: VideoFrameTask, startRow: number, rowCount: number): void {
  if (!Number.isInteger(startRow) || !Number.isInteger(rowCount) || startRow < 0 || rowCount < 1 || startRow + rowCount > task.height) {
    throw new RangeError('Invalid video strip bounds.');
  }
}

function rows(input: Bytes, task: VideoFrameTask, startRow: number, rowCount: number, output: Uint8ClampedArray, outputRow: number): void {
  for (let y = startRow; y < startRow + rowCount; y += 1) {
    for (let x = 0; x < task.width; x += 1) {
      output.set(pixel(input, task.width, task.height, task.settings, x, y), ((y - startRow + outputRow) * task.width + x) * 4);
    }
  }
}

export function processVideoRows(input: Bytes, task: VideoFrameTask, startRow: number, rowCount: number): Uint8ClampedArray {
  assertVideoInput(input, task); validateRows(task, startRow, rowCount);
  const output = new Uint8ClampedArray(task.width * rowCount * 4);
  rows(input, task, startRow, rowCount, output, 0);
  return output;
}

export function processVideoFrame(input: Bytes, task: VideoFrameTask): Uint8ClampedArray {
  return processVideoRows(input, task, 0, task.height);
}

function abortError(): Error { const error = new Error('Video processing cancelled.'); error.name = 'AbortError'; return error; }

export interface VideoRowsOptions {
  signal?: AbortSignal;
  dutyCycle?: number;
  rowsPerChunk?: number;
  onProgress?: (rows: number) => void;
  now?: () => number;
  yieldControl?: (milliseconds: number) => Promise<void>;
}

export async function processVideoRowsAsync(input: Bytes, task: VideoFrameTask, startRow: number, rowCount: number,
  options: VideoRowsOptions = {}): Promise<{ pixels: Uint8ClampedArray; activeMs: number }> {
  assertVideoInput(input, task); validateRows(task, startRow, rowCount);
  const duty = options.dutyCycle ?? 1;
  const chunk = options.rowsPerChunk ?? 2;
  if (!Number.isFinite(duty) || duty <= 0 || duty > 1 || !Number.isInteger(chunk) || chunk < 1 || chunk > 16) {
    throw new RangeError('Invalid video CPU processing budget.');
  }
  const now = options.now ?? (() => performance.now());
  const pause = options.yieldControl ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const output = new Uint8ClampedArray(task.width * rowCount * 4);
  let activeMs = 0;
  for (let completed = 0; completed < rowCount; completed += chunk) {
    if (options.signal?.aborted) throw abortError();
    const count = Math.min(chunk, rowCount - completed);
    const start = now();
    rows(input, task, startRow + completed, count, output, completed);
    const elapsed = Math.max(0, now() - start);
    activeMs += elapsed;
    options.onProgress?.(completed + count);
    // Include the final chunk so a stream of short strips cannot bypass the configured duty cycle.
    await pause(Math.ceil(elapsed * (1 / duty - 1)));
  }
  if (options.signal?.aborted) throw abortError();
  return { pixels: output, activeMs };
}
