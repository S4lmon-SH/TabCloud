import { DEFAULT_SETTINGS, type RenderSettings } from '@tabcloud/shared';

export interface RenderPreset {
  id: 'quick' | 'demo' | 'heavy';
  name: string;
  detail: string;
  settings: RenderSettings;
}

// More useful pixel work, with the same deterministic engine and one Worker.
// Resolution and iterations change together; no artificial waits or idle loops.
export const RENDER_PRESETS: readonly RenderPreset[] = [
  { id: 'quick', name: '가볍게', detail: '1,024px · 500회', settings: { ...DEFAULT_SETTINGS } },
  { id: 'demo', name: '시연용', detail: '2,048px · 8,000회', settings: { ...DEFAULT_SETTINGS, width: 2048, height: 2048, maxIterations: 8000 } },
  { id: 'heavy', name: '최대 부하', detail: '2,048px · 20,000회', settings: { ...DEFAULT_SETTINGS, width: 2048, height: 2048, maxIterations: 20000 } },
];

export const DEFAULT_DEMO_SETTINGS: Readonly<RenderSettings> = Object.freeze({ ...RENDER_PRESETS[1].settings });
