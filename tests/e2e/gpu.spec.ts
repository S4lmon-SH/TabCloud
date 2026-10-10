import { test, expect, chromium } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test('real WebGPU pixels preserve CPU validation tolerance and abort destroys in-flight resources', async ({ baseURL }) => {
  const compiled = await build({ entryPoints: [resolve('tests/helpers/gpu-browser.ts')], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'TabCloudGpuTest', target: 'es2022' });
  // Full Chromium's new headless mode can use a real adapter; headless_shell usually cannot.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/healthz`);
    await page.route('**/__test_gpu_renderer.js', (route) => route.fulfill({
      status: 200, contentType: 'text/javascript', body: compiled.outputFiles[0]!.text,
    }));
    await page.addScriptTag({ url: `${baseURL}/__test_gpu_renderer.js` });
    const result = await page.evaluate(() => (globalThis as unknown as {
      TabCloudGpuTest: typeof import('../helpers/gpu-browser');
    }).TabCloudGpuTest.checkGpuParity());
    if (process.env.REQUIRE_WEBGPU === '1') expect(result.available, 'This run requires a WebGPU adapter.').toBe(true);
    test.skip(!result.available, 'No WebGPU adapter in this browser/environment; CPU fallback is covered separately.');
    if (!result.available) return;
    test.info().annotations.push({ type: 'WebGPU adapter', description: `${result.label}; software fallback=${result.isFallbackAdapter}` });
    for (const measurement of result.measurements) {
      expect(measurement.maxDifference, JSON.stringify(measurement)).toBeLessThanOrEqual(1);
      expect(measurement.correctedPixels).toBeLessThan(measurement.pixelCount * 0.4);
    }
    expect(result.abortName).toBe('AbortError');
    expect(result.lostAfterAbort).toBe(true);
  } finally {
    await browser.close();
  }
});
