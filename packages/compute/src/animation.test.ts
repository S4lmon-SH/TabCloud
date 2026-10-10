import { describe, expect, it } from 'vitest';
import type { AnimationSettings, FrameTask } from '@tabcloud/shared';
import { prepareAnimationScene, renderAnimationFrame, renderAnimationFrameAsync, renderAnimationPixel, renderAnimationRowsAsync, renderAnimationScenePixel } from './animation';

const settings: AnimationSettings = { width: 64, height: 64, frames: 24, fps: 24, samples: 2, bounces: 3 };
const frame = (frameIndex = 0, overrides: Partial<AnimationSettings> = {}): FrameTask => ({
  jobId: 'animation-test', taskId: `frame:${frameIndex}`, frameIndex,
  settings: { ...settings, ...overrides }, algorithmVersion: 'raytrace-v1',
});

describe('deterministic animated 3D ray tracer', () => {
  it('returns an opaque nonuniform frame and exactly reproducible standalone sample pixels', () => {
    const task = frame();
    const output = renderAnimationFrame(task);
    expect(output).toHaveLength(64 * 64 * 4);
    expect(output.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
    const uniqueColors = new Set<string>();
    for (const [x, y] of [[0, 0], [10, 11], [31, 31], [12, 45], [45, 30], [63, 63]]) {
      const offset = (y! * 64 + x!) * 4;
      const sample = renderAnimationPixel(task.settings, 0, x!, y!);
      expect([...output.subarray(offset, offset + 4)]).toEqual(sample);
      uniqueColors.add(sample.join(','));
    }
    expect(uniqueColors.size).toBeGreaterThan(4);
    expect(renderAnimationFrame(task)).toEqual(output);
  });

  it('animates the scene and remains independent of job identifiers and render order', () => {
    const first = renderAnimationFrame(frame(0));
    const quarter = renderAnimationFrame(frame(6));
    expect(quarter).not.toEqual(first);
    const repeated = renderAnimationFrame({ ...frame(0), jobId: 'different', taskId: 'different:0' });
    expect(repeated).toEqual(first);
  });

  it('really traces more samples and reflections when quality is increased', () => {
    const low = renderAnimationFrame(frame(0, { samples: 1, bounces: 1 }));
    const sampled = renderAnimationFrame(frame(0, { samples: 8, bounces: 1 }));
    const reflected = renderAnimationFrame(frame(0, { samples: 1, bounces: 4 }));
    expect(sampled).not.toEqual(low);
    expect(reflected).not.toEqual(low);
  });

  it('accepts maximum bounded settings without needing to allocate a full frame for a sample', () => {
    const maximum: AnimationSettings = { width: 1280, height: 720, frames: 240, fps: 24, samples: 32, bounces: 4 };
    const sample = renderAnimationPixel(maximum, 239, 1279, 719);
    expect(sample).toHaveLength(4);
    expect(sample.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);
    expect(sample[3]).toBe(255);
  });

  it.each([
    { width: 63 }, { width: 1290 }, { width: 65 }, { height: 722 }, { height: 65 },
    { frames: 0 }, { frames: 241 }, { samples: 0 }, { samples: 33 }, { samples: 1.5 },
    { bounces: 0 }, { bounces: 5 }, { fps: 30 }, { width: Number.NaN },
  ])('rejects invalid allocation or workload bounds %o', (overrides) => {
    expect(() => renderAnimationFrame(frame(0, overrides as Partial<AnimationSettings>))).toThrow(RangeError);
  });

  it('rejects unsupported algorithms, bad frame indices and out-of-bounds validation pixels', () => {
    expect(() => renderAnimationFrame({ ...frame(), algorithmVersion: 'unknown' as 'raytrace-v1' })).toThrow(RangeError);
    for (const index of [-1, 24, 1.5, Infinity]) expect(() => renderAnimationFrame(frame(index))).toThrow(RangeError);
    for (const [x, y] of [[-1, 0], [64, 0], [0, 64], [0.5, 0], [0, Number.NaN]]) {
      expect(() => renderAnimationPixel(settings, 0, x!, y!)).toThrow(RangeError);
    }
  });
});

describe('cooperative animation Worker computation', () => {
  it('produces identical bytes for different row chunk sizes with monotonic progress', async () => {
    const rows: number[] = [];
    let yields = 0;
    const task = frame(4);
    const output = await renderAnimationFrameAsync(task, {
      rowsPerChunk: 13, onProgress: (row) => rows.push(row),
      yieldControl: async () => { yields += 1; },
    });
    expect(rows).toEqual([13, 26, 39, 52, 64]);
    expect(yields).toBe(4);
    expect(output).toEqual(renderAnimationFrame(task));
    expect(await renderAnimationFrameAsync(task, { rowsPerChunk: 32, yieldControl: async () => {} })).toEqual(output);
  });

  it('stops before rendering if the job is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let progress = 0;
    await expect(renderAnimationFrameAsync(frame(), { signal: controller.signal, onProgress: () => { progress += 1; } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toBe(0);
  });

  it('cancels between row chunks even at maximum sample and bounce quality', async () => {
    const rows: number[] = [];
    const controller = new AbortController();
    await expect(renderAnimationFrameAsync(frame(0, { samples: 32, bounces: 4 }), {
      signal: controller.signal, rowsPerChunk: 2, onProgress: (row) => rows.push(row),
      yieldControl: async () => { controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(rows).toEqual([2]);
  });

  it('does not publish results cancelled by the final progress callback', async () => {
    const controller = new AbortController();
    await expect(renderAnimationFrameAsync(frame(), {
      signal: controller.signal, rowsPerChunk: 32, yieldControl: async () => {},
      onProgress: (row) => { if (row === 64) controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([0, -1, 33, 1.5, Number.NaN])('rejects invalid chunk size %s', async (rowsPerChunk) => {
    await expect(renderAnimationFrameAsync(frame(), { rowsPerChunk })).rejects.toThrow(RangeError);
  });
});

describe('independent, duty-limited CPU row strips', () => {
  it('merges out-of-order strips into the exact full frame without seams or quality changes', async () => {
    const task = frame(7);
    const strips = [[19, 21], [0, 19], [40, 24]] as const;
    const merged = new Uint8ClampedArray(64 * 64 * 4);
    for (const [start, count] of strips) {
      const rows: number[] = [];
      const pixels = await renderAnimationRowsAsync(task, start, count, {
        onProgress: (row) => rows.push(row), yieldControl: async () => {},
      });
      expect(pixels).toHaveLength(count * 64 * 4);
      expect(rows.at(-1)).toBe(count);
      expect(rows.every((row, index) => row > (rows[index - 1] ?? 0))).toBe(true);
      merged.set(pixels, start * 64 * 4);
    }
    expect(merged).toEqual(renderAnimationFrame(task));
    const scene = prepareAnimationScene(task.settings, task.frameIndex);
    expect(renderAnimationScenePixel(scene, 20, 45)).toEqual(renderAnimationPixel(task.settings, task.frameIndex, 20, 45));
  });

  it('sleeps after every measured burst including the last to honor fractional CPU budgets', async () => {
    let ticks = 0;
    let activeMs = 0;
    const sleeps: number[] = [];
    const rows: number[] = [];
    await renderAnimationRowsAsync(frame(), 7, 5, {
      dutyCycle: 0.25, now: () => ticks++ * 2,
      onActiveTime: (duration) => { activeMs += duration; },
      sleep: async (ms) => { sleeps.push(ms); }, onProgress: (row) => rows.push(row),
    });
    expect(rows).toEqual([1, 3, 5]);
    expect(activeMs).toBe(6);
    expect(sleeps).toEqual([6, 6, 6]);
    expect(activeMs / (activeMs + sleeps.reduce((sum, ms) => sum + ms, 0))).toBe(0.25);
  });

  it('reduces chunk size after a slow burst and yields at full CPU duty', async () => {
    let ticks = 0;
    let yields = 0;
    const rows: number[] = [];
    await renderAnimationRowsAsync(frame(), 0, 3, {
      dutyCycle: 1, now: () => ticks++ * 30, onProgress: (row) => rows.push(row),
      yieldControl: async () => { yields += 1; },
    });
    expect(rows).toEqual([1, 2, 3]);
    expect(yields).toBe(2);
  });

  it('cancels during the final duty wait and never returns the computed strip', async () => {
    const controller = new AbortController();
    let ticks = 0;
    await expect(renderAnimationRowsAsync(frame(), 0, 1, {
      dutyCycle: 0.25, now: () => ticks++ * 2, signal: controller.signal,
      sleep: async () => { controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not allocate or start a strip that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let bursts = 0;
    await expect(renderAnimationRowsAsync(frame(), 0, 1, {
      signal: controller.signal, onActiveTime: () => { bursts += 1; },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(bursts).toBe(0);
  });

  it.each([[-1, 1], [64, 1], [0, 0], [0, 65], [63, 2], [1.5, 1], [0, Number.NaN]])('rejects out-of-frame row ranges %s, %s', async (start, count) => {
    await expect(renderAnimationRowsAsync(frame(), start, count)).rejects.toThrow(RangeError);
  });

  it.each([0, -1, 1.1, Number.NaN, Infinity])('rejects invalid duty cycle %s', async (dutyCycle) => {
    await expect(renderAnimationRowsAsync(frame(), 0, 1, { dutyCycle })).rejects.toThrow(RangeError);
  });
});
