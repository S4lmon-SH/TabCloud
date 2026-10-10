import { ALGORITHM_VERSION, renderSettingsSchema, type RenderSettings, type TileTask } from '@tabcloud/shared';

export { renderAnimationPixel, renderAnimationFrame, renderAnimationFrameAsync, type AsyncAnimationOptions } from './animation';

export type RgbaPixel = [number, number, number, number];

// Versioned integer RGB palette; no logarithmic/smooth color interpolation varies between engines.
const PALETTE = [
  [66, 30, 15], [25, 7, 26], [9, 1, 47], [4, 4, 73],
  [0, 7, 100], [12, 44, 138], [24, 82, 177], [57, 125, 209],
  [134, 181, 229], [211, 236, 248], [241, 233, 191], [248, 201, 95],
  [255, 170, 0], [204, 128, 0], [153, 87, 0], [106, 52, 3],
] as const;

/** Pixel-center mapping. `span` is horizontal; square pixels preserve aspect ratio. */
export function renderPixel(settings: RenderSettings, x: number, y: number): RgbaPixel {
  const real = settings.centerX + ((x + 0.5) / settings.width - 0.5) * settings.span;
  const imaginary = settings.centerY + ((y + 0.5) / settings.height - 0.5) * settings.span * settings.height / settings.width;
  let zr = 0;
  let zi = 0;
  let iterations = 0;
  while (zr * zr + zi * zi <= 4 && iterations < settings.maxIterations) {
    const nextReal = zr * zr - zi * zi + real;
    zi = 2 * zr * zi + imaginary;
    zr = nextReal;
    iterations += 1;
  }
  if (iterations === settings.maxIterations) return [9, 14, 27, 255];
  const [red, green, blue] = PALETTE[iterations % PALETTE.length]!;
  return [red, green, blue, 255];
}

/** Stable row-major tasks, including partial tiles at right/bottom image boundaries. */
export function createTiles(jobId: string, input: RenderSettings): TileTask[] {
  const settings = renderSettingsSchema.parse(input);
  const tasks: TileTask[] = [];
  for (let y = 0; y < settings.height; y += settings.tileSize) {
    for (let x = 0; x < settings.width; x += settings.tileSize) {
      tasks.push({
        jobId,
        taskId: `${jobId}:${x}:${y}`,
        x,
        y,
        width: Math.min(settings.tileSize, settings.width - x),
        height: Math.min(settings.tileSize, settings.height - y),
        settings,
        algorithmVersion: ALGORITHM_VERSION,
      });
    }
  }
  return tasks;
}

function assertTile(task: TileTask): void {
  if (task.algorithmVersion !== ALGORITHM_VERSION || !Number.isInteger(task.x) || !Number.isInteger(task.y)
    || !Number.isInteger(task.width) || !Number.isInteger(task.height)
    || task.x < 0 || task.y < 0 || task.width < 1 || task.height < 1
    || task.width > task.settings.tileSize || task.height > task.settings.tileSize
    || task.x + task.width > task.settings.width || task.y + task.height > task.settings.height) {
    throw new RangeError('Unsupported or out-of-bounds tile.');
  }
}

function renderRows(task: TileTask, pixels: Uint8ClampedArray, start: number, end: number): void {
  for (let y = start; y < end; y += 1) {
    for (let x = 0; x < task.width; x += 1) {
      pixels.set(renderPixel(task.settings, task.x + x, task.y + y), (y * task.width + x) * 4);
    }
  }
}

export function renderTile(task: TileTask): Uint8ClampedArray {
  assertTile(task);
  const pixels = new Uint8ClampedArray(task.width * task.height * 4);
  renderRows(task, pixels, 0, task.height);
  return pixels;
}

export interface AsyncRenderOptions {
  rowsPerChunk?: number;
  onProgress?: (completedRows: number) => void;
  signal?: AbortSignal;
  yieldControl?: () => Promise<void>;
}

/** Yield between row chunks so a Worker can publish progress and process cancellation. */
export async function renderTileAsync(task: TileTask, options: AsyncRenderOptions = {}): Promise<Uint8ClampedArray> {
  assertTile(task);
  const chunk = options.rowsPerChunk ?? 4;
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > 128) throw new RangeError('Invalid rowsPerChunk.');
  const pixels = new Uint8ClampedArray(task.width * task.height * 4);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  for (let row = 0; row < task.height; row += chunk) {
    if (options.signal?.aborted) {
      const error = new Error('Rendering cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    const end = Math.min(row + chunk, task.height);
    renderRows(task, pixels, row, end);
    options.onProgress?.(end);
    if (end < task.height) await yieldControl();
  }
  return pixels;
}

/** Copy one tile into a full RGBA image; rejects mismatched buffers instead of clipping. */
export function mergeTile(target: Uint8ClampedArray, task: TileTask, pixels: Uint8ClampedArray | Uint8Array): void {
  assertTile(task);
  if (target.length !== task.settings.width * task.settings.height * 4 || pixels.length !== task.width * task.height * 4) {
    throw new RangeError('RGBA buffer length does not match image/tile dimensions.');
  }
  const rowBytes = task.width * 4;
  for (let row = 0; row < task.height; row += 1) {
    const destination = ((task.y + row) * task.settings.width + task.x) * 4;
    target.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), destination);
  }
}

/** FNV-1a over RGBA bytes, returned as 8 lower-case hex digits. Comparison only, not authentication. */
export function checksum(pixels: Uint8ClampedArray | Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of pixels) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
