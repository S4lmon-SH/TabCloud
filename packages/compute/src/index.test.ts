import { describe, expect, it } from 'vitest';
import { ALGORITHM_VERSION, DEFAULT_SETTINGS, LIMITS, type RenderSettings, type TileTask } from '@tabcloud/shared';
import { checksum, createTiles, mergeTile, renderPixel, renderTile, renderTileAsync } from './index';

const settings: RenderSettings = { ...DEFAULT_SETTINGS, width: 70, height: 95, tileSize: 32, maxIterations: 120 };

describe('row-major tiling', () => {
  it('covers every pixel exactly once, including partial edge tiles', () => {
    const tiles = createTiles('coverage', settings);
    const coverage = new Uint8Array(settings.width * settings.height);
    expect(tiles).toHaveLength(9);
    expect(new Set(tiles.map((tile) => tile.taskId)).size).toBe(tiles.length);
    for (const tile of tiles) {
      expect(tile.algorithmVersion).toBe(ALGORITHM_VERSION);
      expect(tile.jobId).toBe('coverage');
      for (let y = tile.y; y < tile.y + tile.height; y += 1) {
        for (let x = tile.x; x < tile.x + tile.width; x += 1) coverage[y * settings.width + x]! += 1;
      }
    }
    expect(coverage.every((count) => count === 1)).toBe(true);
    expect(tiles.at(-1)).toMatchObject({ x: 64, y: 64, width: 6, height: 31 });
  });

  it('creates 64 default tiles without retaining the caller settings object', () => {
    const input = { ...DEFAULT_SETTINGS };
    const tiles = createTiles('default', input);
    input.width = 128;
    expect(tiles).toHaveLength(64);
    expect(tiles[0]!.settings.width).toBe(1024);
  });

  it('rejects invalid settings before allocating any tiles', () => {
    expect(() => createTiles('invalid', { ...settings, width: 999999 })).toThrow();
  });

  it('keeps tile and image buffers bounded at the maximum iteration workload', () => {
    const maximum = { ...DEFAULT_SETTINGS, width: 2048, height: 2048, maxIterations: LIMITS.maxIterations };
    for (const tileSize of LIMITS.tileSizes) {
      const tiles = createTiles('maximum', { ...maximum, tileSize });
      expect(tiles.length).toBeLessThanOrEqual(LIMITS.maxTiles);
      expect(tiles.every((tile) => tile.width * tile.height * 4 <= LIMITS.maxTileBytes)).toBe(true);
      expect(tiles.reduce((bytes, tile) => bytes + tile.width * tile.height * 4, 0)).toBe(LIMITS.maxPixels * 4);
    }
    expect(() => createTiles('too-many-iterations', { ...maximum, maxIterations: LIMITS.maxIterations + 1 })).toThrow();
  });
});

describe('versioned Mandelbrot computation', () => {
  it('matches analytically known complex points and the fixed escape palette', () => {
    // Offset half a pixel so (31,31) maps exactly to c=0, and (63,31) maps to c=2.
    const exact: RenderSettings = { ...DEFAULT_SETTINGS, width: 64, height: 64, centerX: 0.03125,
      centerY: 0.03125, span: 4, maxIterations: 20 };
    expect(renderPixel(exact, 31, 31)).toEqual([9, 14, 27, 255]); // c=0: interior
    expect(renderPixel(exact, 15, 31)).toEqual([9, 14, 27, 255]); // c=-1: interior
    expect(renderPixel(exact, 63, 31)).toEqual([9, 1, 47, 255]); // c=2: escape iteration 2
    expect(renderPixel(exact, 47, 31)).toEqual([4, 4, 73, 255]); // c=1: escape iteration 3
    expect(renderPixel(exact, 63, 63)).toEqual([25, 7, 26, 255]); // c=2+2i: escape iteration 1
  });

  it('preserves square pixel spacing on a non-square viewport', () => {
    const landscape: RenderSettings = { ...DEFAULT_SETTINGS, width: 128, height: 64,
      centerX: 0.015625, centerY: 0.015625, span: 4, maxIterations: 20 };
    expect(renderPixel(landscape, 63, 31)).toEqual([9, 14, 27, 255]);
    expect(renderPixel(landscape, 95, 31)).toEqual([4, 4, 73, 255]); // c=1
    expect(renderPixel(landscape, 127, 63)).toEqual([25, 7, 26, 255]); // c=2+i
  });

  it('merges shuffled distributed tiles into the exact one-tile reference image', () => {
    const singleTask: TileTask = {
      jobId: 'reference', taskId: 'reference:0:0', x: 0, y: 0,
      width: settings.width, height: settings.height,
      settings: { ...settings, tileSize: 128 }, algorithmVersion: ALGORITHM_VERSION,
    };
    const reference = renderTile(singleTask);
    const merged = new Uint8ClampedArray(settings.width * settings.height * 4);
    const tasks = createTiles('distributed', settings);
    for (const task of tasks.reverse()) mergeTile(merged, task, renderTile(task));
    expect(merged).toEqual(reference);
    expect(checksum(merged)).toBe(checksum(reference));
    expect(renderTile(singleTask)).toEqual(reference);
    const beforeDuplicate = checksum(merged);
    mergeTile(merged, tasks[0]!, renderTile(tasks[0]!));
    expect(checksum(merged)).toBe(beforeDuplicate);
  });

  it('refuses out-of-bounds tiles, unknown algorithm versions and invalid buffers', () => {
    const task = createTiles('bounds', settings)[0]!;
    const target = new Uint8ClampedArray(settings.width * settings.height * 4);
    expect(() => renderTile({ ...task, x: settings.width })).toThrow(RangeError);
    expect(() => renderTile({ ...task, algorithmVersion: 'unknown' as typeof ALGORITHM_VERSION })).toThrow(RangeError);
    expect(() => mergeTile(target, task, new Uint8Array(4))).toThrow(RangeError);
    expect(() => mergeTile(new Uint8ClampedArray(4), task, renderTile(task))).toThrow(RangeError);
  });
});

describe('cooperative Worker rendering', () => {
  it('yields between chunks, reports monotonic row progress, and returns identical bytes', async () => {
    const task = createTiles('async', settings)[0]!;
    const rows: number[] = [];
    let yields = 0;
    const result = await renderTileAsync(task, { rowsPerChunk: 7, onProgress: (row) => rows.push(row),
      yieldControl: async () => { yields += 1; } });
    expect(rows).toEqual([7, 14, 21, 28, 32]);
    expect(yields).toBe(4);
    expect(result).toEqual(renderTile(task));
  });

  it('honors cancellation before continuing a chunk', async () => {
    const controller = new AbortController();
    const rows: number[] = [];
    const task = createTiles('cancel', settings)[0]!;
    await expect(renderTileAsync(task, { signal: controller.signal,
      onProgress: (row) => rows.push(row), yieldControl: async () => { controller.abort(); } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(rows).toEqual([4]);
  });

  it('remains cancellable between chunks at the maximum iteration workload', async () => {
    const maximum: RenderSettings = { ...DEFAULT_SETTINGS, width: 64, height: 64, tileSize: 32,
      centerX: 0, centerY: 0, span: 0.000001, maxIterations: LIMITS.maxIterations };
    const task = { ...createTiles('high-workload', maximum)[0]!, width: 8, height: 16 };
    const rows: number[] = [];
    const controller = new AbortController();
    await expect(renderTileAsync(task, { rowsPerChunk: 8, signal: controller.signal,
      onProgress: (row) => rows.push(row), yieldControl: async () => { controller.abort(); } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(rows).toEqual([8]);
    const result = await renderTileAsync(task, { yieldControl: async () => {} });
    expect(result).toEqual(renderTile(task));
    expect(result.subarray(0, 4)).toEqual(new Uint8ClampedArray([9, 14, 27, 255]));
  });

  it('rejects invalid chunks rather than creating an infinite loop', async () => {
    const task = createTiles('invalid', settings)[0]!;
    await expect(renderTileAsync(task, { rowsPerChunk: 0 })).rejects.toThrow(RangeError);
  });
});

describe('comparison checksum', () => {
  it('matches published FNV-1a byte test vectors', () => {
    expect(checksum(new Uint8Array())).toBe('811c9dc5');
    expect(checksum(new Uint8Array([104, 101, 108, 108, 111]))).toBe('4f9f2cab');
    expect(checksum(new Uint8Array([104, 101, 108, 108, 112]))).not.toBe('4f9f2cab');
  });
});
