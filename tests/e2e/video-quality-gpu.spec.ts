import { chromium, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VideoSnapshot } from '../../packages/shared/src/index';
import { makeVideoFixture, checkVideoAudio } from '../helpers/video-fixture';

test('1080p60 upload crosses frame windows on real hardware GPU and preserves output frames and audio', async ({ baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const browser = await chromium.launch({ channel: 'chromium' });
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-1080p60-'));
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    let latest: VideoSnapshot | null = null;
    let compressedResults = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/result?') && new URL(request.url()).searchParams.get('encoding') === 'gzip') compressedResults++;
    });
    page.on('response', (response) => {
      if (response.ok() && response.url().endsWith('/state')) void response.json().then((snapshot: VideoSnapshot) => { latest = snapshot; }).catch(() => {});
    });
    await page.goto(baseURL!);
    const hardware = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      return Boolean(adapter && Reflect.get(adapter.info, 'isFallbackAdapter') === false);
    });
    if (process.env.REQUIRE_WEBGPU === '1') expect(hardware).toBe(true);
    test.skip(!hardware, 'A verified hardware WebGPU adapter is required.');
    await page.getByRole('button', { name: '방 만들기', exact: true }).click();
    await expect(page).toHaveURL(/\/video\//);
    await page.getByTestId('video-upload').setInputFiles(makeVideoFixture(directory, 30, 1920, 1080, 60));
    await expect(page.getByTestId('video-source-status')).toHaveAttribute('data-status', 'ready', { timeout: 45_000 });
    await expect(page.getByTestId('video-output-summary')).toContainText('1920 × 1080 · 60fps');
    await expect(page.getByTestId('resource-gpuPercent')).toBeEnabled();
    await page.getByTestId('resource-cpuPercent').fill('0');
    await page.getByTestId('resource-gpuPercent').fill('100');
    await page.getByRole('button', { name: '처리 시작', exact: true }).click();
    await page.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
    await expect.poll(() => latest?.job?.completedFrames).toBe(30);
    const snapshot = latest! as VideoSnapshot;
    expect(snapshot.job).toMatchObject({ width: 1920, height: 1080, fps: 60, totalFrames: 30, frameCountExact: true });
    expect(snapshot.participants.reduce((sum, peer) => sum + peer.gpuFrames, 0)).toBe(30);
    expect(snapshot.participants.reduce((sum, peer) => sum + peer.cpuFrames, 0)).toBe(0);
    expect(compressedResults).toBe(30);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '영상 다운로드', exact: true }).click();
    const resultPath = join(directory, '1080p60-filtered.mp4');
    await (await downloadEvent).saveAs(resultPath);
    const ffmpeg = createRequire(resolve('apps/server/package.json'))('ffmpeg-static') as string;
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-i', resultPath, '-map', '0:v:0', '-an', '-progress', 'pipe:1', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(decoded.status, decoded.stderr).toBe(0);
    expect(decoded.stderr).toMatch(/1920x1080.*60 fps/);
    expect(Number([...decoded.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1])).toBe(30);
    const audio = checkVideoAudio(resultPath);
    expect(audio.nonSilent).toBe(true); expect(audio.samples).toBeGreaterThanOrEqual(24_000);
    expect(errors).toEqual([]);
    const proof = testInfo.outputPath('1080p60-gpu.json');
    await writeFile(proof, JSON.stringify({ width: 1920, height: 1080, fps: 60, frames: 30, hardware, compressedResults, audio, job: snapshot.job }, null, 2));
    await testInfo.attach('1080p60-gpu', { path: proof, contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('1080p60-completed.png'), fullPage: true });
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
