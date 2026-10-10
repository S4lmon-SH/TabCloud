import { describe, expect, it } from 'vitest';
import { ANIMATION_PRESETS, animationSettingsSchema, DEFAULT_ANIMATION_SETTINGS } from './animation.js';

describe('bounded animation settings', () => {
  it('accepts every actual preset and the maximum supported workload', () => {
    for (const preset of ANIMATION_PRESETS) expect(animationSettingsSchema.parse(preset.settings)).toEqual(preset.settings);
    expect(animationSettingsSchema.safeParse({ ...DEFAULT_ANIMATION_SETTINGS, frames: 240, samples: 32, bounces: 4 }).success).toBe(true);
  });
  it.each([
    { width: 1282 }, { height: 722 }, { width: 1279 }, { height: 719 }, { width: 0 },
    { frames: 241 }, { frames: 0 }, { frames: 1.5 }, { fps: 30 }, { samples: 0 },
    { samples: 33 }, { bounces: 5 }, { bounces: 0 }, { width: NaN }, { height: Infinity },
    { source: 'untrusted arbitrary scene' },
  ])('rejects unsupported input %j', (change) => {
    expect(animationSettingsSchema.safeParse({ ...DEFAULT_ANIMATION_SETTINGS, ...change }).success).toBe(false);
  });
});
