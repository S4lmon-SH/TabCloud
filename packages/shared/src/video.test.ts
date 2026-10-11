import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_PROCESSING, DEFAULT_VIDEO_OUTPUT, VIDEO_LIMITS, videoProcessingSettingsSchema, videoOutputSettingsSchema, resolveVideoOutput, isSupportedVideoDimensions, getVideoFrameWindow } from './video.js';

describe('uploaded video filter settings', () => {
  it('accepts the defaults and the full supported range', () => {
    expect(videoProcessingSettingsSchema.parse(DEFAULT_VIDEO_PROCESSING)).toEqual(DEFAULT_VIDEO_PROCESSING);
    expect(videoProcessingSettingsSchema.safeParse({ denoise: 0, denoiseRadius: 1, sharpen: 0, brightness: -50, contrast: 50, saturation: 0 }).success).toBe(true);
    expect(videoProcessingSettingsSchema.safeParse({ denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: 50, contrast: 150, saturation: 200 }).success).toBe(true);
    expect(VIDEO_LIMITS.maxFrames).toBe(VIDEO_LIMITS.maxFps * VIDEO_LIMITS.maxDurationSeconds);
  });

  it.each([
    { denoise: -1 }, { denoise: 101 }, { denoiseRadius: 0 }, { denoiseRadius: 5 },
    { sharpen: 101 }, { brightness: -51 }, { brightness: 51 }, { contrast: 49 },
    { contrast: 151 }, { saturation: -1 }, { saturation: 201 }, { sharpen: 0.5 },
    { denoise: NaN }, { brightness: Infinity }, { contrast: '100' }, { command: 'custom-filter' },
  ])('rejects unsupported filter parameters %j', (change) => {
    expect(videoProcessingSettingsSchema.safeParse({ ...DEFAULT_VIDEO_PROCESSING, ...change }).success).toBe(false);
  });
});

describe('video output profiles', () => {
  it('preserves landscape and portrait aspect without upscaling, and retains fractional source fps', () => {
    expect(resolveVideoOutput({ width: 3840, height: 2160, fps: 30000 / 1001 }, DEFAULT_VIDEO_OUTPUT)).toEqual({ width: 1920, height: 1080, fps: 30000 / 1001 });
    expect(resolveVideoOutput({ width: 2160, height: 3840, fps: 120 }, DEFAULT_VIDEO_OUTPUT)).toEqual({ width: 1080, height: 1920, fps: 60 });
    expect(resolveVideoOutput({ width: 640, height: 480, fps: 25 }, { ...DEFAULT_VIDEO_OUTPUT, fps: 60 })).toEqual({ width: 640, height: 480, fps: 60 });
    expect(resolveVideoOutput({ width: 1080, height: 1920, fps: 50 }, { resolution: '720p', fps: 30, quality: 'compact' })).toEqual({ width: 720, height: 1280, fps: 30 });
  });
  it('accepts exact supported display bounds and rejects excessive or invalid dimensions', () => {
    expect(isSupportedVideoDimensions(1920, 1080)).toBe(true);
    expect(isSupportedVideoDimensions(1080, 1920)).toBe(true);
    for (const [width, height] of [[1921, 1080], [1080, 1921], [1400, 1400], [0, 4], [NaN, 4], [4.5, 4]]) expect(isSupportedVideoDimensions(width!, height!)).toBe(false);
    expect(() => resolveVideoOutput({ width: 0, height: 1080, fps: 30 }, DEFAULT_VIDEO_OUTPUT)).toThrow();
  });
  it('bounds raw frame storage to 64 MiB across supported resolutions and orientations', () => {
    expect(getVideoFrameWindow(1920, 1080)).toBe(4);
    expect(getVideoFrameWindow(1080, 1920)).toBe(4);
    expect(getVideoFrameWindow(1280, 720)).toBe(10);
    expect(getVideoFrameWindow(64, 64)).toBe(24);
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1280, 720], [1080, 1080], [64, 64], [1, 1]]) {
      const window = getVideoFrameWindow(width!, height!);
      expect(window * (width! * height! * 7 + 128)).toBeLessThanOrEqual(VIDEO_LIMITS.rawWindowBytes);
      expect(window).toBeGreaterThanOrEqual(1); expect(window).toBeLessThanOrEqual(VIDEO_LIMITS.frameWindow);
    }
    expect(() => getVideoFrameWindow(3840, 2160)).toThrow(RangeError);
    expect(() => getVideoFrameWindow(0, 1080)).toThrow(RangeError);
    expect(() => getVideoFrameWindow(Number.NaN, 1080)).toThrow(RangeError);
  });
  it.each([{ resolution: '4k' }, { fps: 120 }, { quality: 'lossless' }, { crf: 0 }, { fps: NaN }])('rejects unsupported output %j', (change) => {
    expect(videoOutputSettingsSchema.safeParse({ ...DEFAULT_VIDEO_OUTPUT, ...change }).success).toBe(false);
  });
});
