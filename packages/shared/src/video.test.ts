import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_PROCESSING, VIDEO_LIMITS, videoProcessingSettingsSchema } from './video.js';

describe('uploaded video filter settings', () => {
  it('accepts the defaults and the full supported range', () => {
    expect(videoProcessingSettingsSchema.parse(DEFAULT_VIDEO_PROCESSING)).toEqual(DEFAULT_VIDEO_PROCESSING);
    expect(videoProcessingSettingsSchema.safeParse({ denoise: 0, denoiseRadius: 1, sharpen: 0, brightness: -50, contrast: 50, saturation: 0 }).success).toBe(true);
    expect(videoProcessingSettingsSchema.safeParse({ denoise: 100, denoiseRadius: 4, sharpen: 100, brightness: 50, contrast: 150, saturation: 200 }).success).toBe(true);
    expect(VIDEO_LIMITS.maxFrames).toBe(VIDEO_LIMITS.fps * VIDEO_LIMITS.maxDurationSeconds);
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
