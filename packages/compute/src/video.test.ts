import { describe, expect, it } from 'vitest';
import type { VideoFrameTask, VideoProcessingSettings } from '@tabcloud/shared';
import { processVideoFrame, processVideoPixel, processVideoRows, processVideoRowsAsync } from './video';

const neutral: VideoProcessingSettings = { denoise: 0, denoiseRadius: 2, sharpen: 0, brightness: 0, contrast: 100, saturation: 100 };
const task = (settings: Partial<VideoProcessingSettings> = {}, width = 17, height = 9): VideoFrameTask => ({
  jobId: 'video-test', taskId: 'frame:0', frameIndex: 0, width, height, settings: { ...neutral, ...settings }, algorithmVersion: 'video-filter-v1',
});
const pattern = (width = 17, height = 9) => Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => (index * 71 + Math.floor(index / 4) * 13) % 256);

describe('integer video processing', () => {
  it('preserves every channel exactly when all filters are neutral', () => {
    const input = pattern(); expect(processVideoFrame(input, task())).toEqual(input);
  });
  it('makes standalone validation pixels and arbitrary strip boundaries exactly match the full frame', () => {
    const frame = task({ denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: -50, contrast: 150, saturation: 200 });
    const input = pattern(); const full = processVideoFrame(input, frame); const merged = new Uint8ClampedArray(full.length);
    for (let row = 0; row < frame.height; row += 4) merged.set(processVideoRows(input, frame, row, Math.min(4, frame.height - row)), row * frame.width * 4);
    expect(merged).toEqual(full);
    for (const [x, y] of [[0, 0], [16, 8], [8, 4], [0, 8]]) expect(processVideoPixel(input, frame, x!, y!)).toEqual([...full.slice((y! * 17 + x!) * 4, (y! * 17 + x!) * 4 + 4)]);
    expect(input).toEqual(pattern());
  });
  it('clamps sampling at tiny frame edges without changing a uniform image', () => {
    const input = new Uint8ClampedArray([101, 88, 176, 37]);
    expect(processVideoFrame(input, task({ denoise: 100, denoiseRadius: 4, sharpen: 100 }, 1, 1))).toEqual(input);
  });
  it('reduces a small isolated luminance fluctuation while preserving a strong edge', () => {
    const input = new Uint8ClampedArray(9 * 9 * 4);
    for (let p = 0; p < 81; p++) input.set([100, 100, 100, 255], p * 4);
    input.set([120, 120, 120, 255], (4 * 9 + 4) * 4);
    const pixel = processVideoPixel(input, task({ denoise: 100, denoiseRadius: 2 }, 9, 9), 4, 4);
    expect(pixel[0]).toBeLessThan(115); expect(pixel[0]).toBeGreaterThanOrEqual(100);
    input.set([255, 255, 255, 255], (4 * 9 + 4) * 4);
    expect(processVideoPixel(input, task({ denoise: 100, denoiseRadius: 2 }, 9, 9), 4, 4)[0]).toBeGreaterThan(245);
  });
  it('sharpens local detail and converts saturation zero to equal RGB channels', () => {
    const input = new Uint8ClampedArray(3 * 3 * 4).fill(100);
    input.set([120, 120, 120, 255], 16);
    expect(processVideoPixel(input, task({ sharpen: 100 }, 3, 3), 1, 1)[0]).toBeGreaterThan(120);
    const gray = processVideoFrame(pattern(), task({ saturation: 0 }));
    for (let offset = 0; offset < gray.length; offset += 4) expect([gray[offset], gray[offset + 1]]).toEqual([gray[offset + 2], gray[offset + 2]]);
  });
  it('uses independent denoise and detail kernels so equal amounts do not cancel into an identity filter', () => {
    const input = pattern();
    const denoised = processVideoFrame(input, task({ denoise: 100, denoiseRadius: 4 }));
    const both = processVideoFrame(input, task({ denoise: 100, denoiseRadius: 4, sharpen: 100 }));
    expect(both).not.toEqual(input); expect(both).not.toEqual(denoised);
    expect(both).not.toEqual(processVideoFrame(input, task({ sharpen: 100 })));
  });
  it('implements signed brightness rounding and safely clips all extremes', () => {
    const input = new Uint8ClampedArray([128, 128, 128, 17]);
    expect([...processVideoFrame(input, task({ brightness: -1 }, 1, 1))]).toEqual([125, 125, 125, 17]);
    expect([...processVideoFrame(input, task({ brightness: 1 }, 1, 1))]).toEqual([131, 131, 131, 17]);
    expect([...processVideoFrame(input, task({ brightness: -50 }, 1, 1))]).toEqual([0, 0, 0, 17]);
    expect([...processVideoFrame(input, task({ brightness: 50 }, 1, 1))]).toEqual([255, 255, 255, 17]);
  });
  it('does not depend on frame identifiers or processing order', () => {
    const input = pattern(); const first = task({ denoise: 60, sharpen: 25 });
    expect(processVideoFrame(input, { ...first, jobId: 'different', frameIndex: 87 })).toEqual(processVideoFrame(input, first));
  });
  it('cooperative processing matches reference bytes and charges the final duty-cycle idle time', async () => {
    const frame = task({ denoise: 60 }); const delays: number[] = []; let time = 0;
    const result = await processVideoRowsAsync(pattern(), frame, 1, 5, {
      dutyCycle: 0.25, rowsPerChunk: 2, now: () => { time += 4; return time; }, yieldControl: async (delay) => { delays.push(delay); },
    });
    expect(result.pixels).toEqual(processVideoRows(pattern(), frame, 1, 5));
    expect(result.activeMs).toBe(12); expect(delays).toEqual([12, 12, 12]);
  });
  it('rejects cancellation between chunks and never publishes the partial buffer', async () => {
    const controller = new AbortController(); let chunks = 0;
    await expect(processVideoRowsAsync(pattern(), task(), 0, 9, {
      signal: controller.signal, onProgress: () => { chunks += 1; controller.abort(); }, yieldControl: async () => {},
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunks).toBe(1);
  });
  it.each([
    { denoise: 101 }, { denoiseRadius: 0 }, { sharpen: -1 }, { brightness: -51 }, { contrast: 151 }, { saturation: Number.NaN },
  ])('rejects invalid settings %j', (settings) => expect(() => processVideoFrame(pattern(), task(settings))).toThrow(RangeError));
  it('rejects bad input sizes, algorithm versions, pixels and strip bounds', () => {
    expect(() => processVideoFrame(new Uint8ClampedArray(8), task())).toThrow(RangeError);
    expect(() => processVideoFrame(pattern(), { ...task(), algorithmVersion: 'wrong' as 'video-filter-v1' })).toThrow(RangeError);
    expect(() => processVideoPixel(pattern(), task(), 17, 0)).toThrow(RangeError);
    expect(() => processVideoRows(pattern(), task(), 8, 2)).toThrow(RangeError);
  });
});
