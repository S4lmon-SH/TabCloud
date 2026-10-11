import { chromium, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

test('hardware GPU video filters match every CPU byte, reuse devices and stop on abort', async ({ baseURL }, testInfo) => {
  const compiled = await build({ entryPoints: [resolve('tests/helpers/video-gpu-browser.ts')], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'TabCloudVideoGpuTest', target: 'es2022' });
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/healthz`);
    await page.route('**/__video_gpu_test.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: compiled.outputFiles[0]!.text }));
    await page.addScriptTag({ url: `${baseURL}/__video_gpu_test.js` });
    const result = await page.evaluate(() => (globalThis as unknown as {
      TabCloudVideoGpuTest: typeof import('../helpers/video-gpu-browser');
    }).TabCloudVideoGpuTest.checkVideoGpu());
    if (process.env.REQUIRE_WEBGPU === '1') expect(result.available, !result.available ? result.reason ?? 'Hardware GPU required' : '').toBe(true);
    test.skip(!result.available, `Hardware GPU unavailable: ${!result.available ? result.reason : ''}`);
    if (!result.available) return;
    expect(result.hardware).toBe(true); expect(result.deviceCreations).toBe(1);
    expect(result.measurements).toHaveLength(5);
    for (const measurement of result.measurements) {
      expect(measurement.maxDifference, JSON.stringify(measurement)).toBe(0);
      expect(measurement.dispatches).toBeGreaterThan(0);
      expect(measurement.busyMs).toBeGreaterThan(0);
      if (result.timestampSupported) expect(measurement.timestampMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.measurements[3]!.allocatedBytes).toBe(result.measurements[4]!.allocatedBytes);
    expect(result.abortName).toBe('AbortError'); expect(result.lostAfterAbort).toBe(true);
    const path = testInfo.outputPath('hardware-video-gpu.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await testInfo.attach('hardware-video-gpu', { path, contentType: 'application/json' });
  } finally { await browser.close(); }
});
