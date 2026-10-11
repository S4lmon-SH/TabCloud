import { chromium, expect, test, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import type { AnimationSnapshot } from '../../packages/shared/src/animation';
import type { ResourceRenderStats } from '../../apps/web/src/resource-renderer';

interface ResourceObservations { created: number; terminated: number; messages: { type: string; stats: ResourceRenderStats }[] }

async function observeRenderer(page: Page) {
  await page.addInitScript(() => {
    const observations: ResourceObservations = { created: 0, terminated: 0, messages: [] };
    (globalThis as unknown as { resourceObservations: ResourceObservations }).resourceObservations = observations;
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        observations.created += 1;
        this.addEventListener('message', ({ data }) => {
          if (data.stats && observations.messages.length < 2000) observations.messages.push({ type: data.type, stats: data.stats });
        });
      }
      override terminate() { observations.terminated += 1; super.terminate(); }
    };
  });
}

async function configure(page: Page, frames: number, width = 320, height = 180, samples = 8) {
  await page.getByText('직접 설정', { exact: true }).click();
  for (const [label, value] of [['너비', width], ['높이', height], ['프레임 수', frames], ['샘플 수', samples], ['반사 횟수', 3]] as const) {
    await page.getByLabel(label, { exact: true }).fill(String(value));
  }
  await page.getByText('직접 설정', { exact: true }).click();
}

for (const cpuPercent of [0, 25]) {
  test(`CPU ${cpuPercent}% and GPU 50% finish real Worker/server/MP4 rendering`, async ({ baseURL }, testInfo) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage();
      await observeRenderer(page);
      const cpuScripts: string[] = [];
      const errors: string[] = [];
      let latest: AnimationSnapshot | null = null;
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => { if (/cpu-render\.worker/.test(request.url())) cpuScripts.push(request.url()); });
      page.on('response', async (response) => {
        if (response.ok() && response.url().endsWith('/state')) latest = await response.json().catch(() => latest) as AnimationSnapshot | null;
        if (response.url().includes('/result?') && response.status() >= 400) errors.push(`frame upload HTTP ${response.status()}`);
      });
      await page.goto(`${baseURL}/animation`);
      const gpuAvailable = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
      if (process.env.REQUIRE_WEBGPU === '1') expect(gpuAvailable).toBe(true);
      test.skip(!gpuAvailable, 'A real WebGPU adapter is unavailable in this environment.');
      await page.getByRole('button', { name: '방 만들기', exact: true }).click();
      await expect(page.getByTestId('resource-gpuPercent')).toBeEnabled();
      await configure(page, 4);
      await page.getByTestId('resource-cpuPercent').fill(String(cpuPercent));
      await page.getByTestId('resource-gpuPercent').fill('50');
      await expect(page.getByTestId('resource-gpu-enabled')).toHaveText('사용');
      if (cpuPercent === 0) await expect(page.getByTestId('resource-cpu-workers')).toHaveText('0개');
      await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
      await page.getByRole('button', { name: '연산 참여', exact: true }).click();
      await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'completed', { timeout: 90000 });
      await expect(page.getByRole('button', { name: '영상 다운로드', exact: true })).toBeEnabled();
      await expect.poll(() => latest?.job?.completedFrames).toBe(4);
      const observations = await page.evaluate(() => (globalThis as unknown as { resourceObservations: ResourceObservations }).resourceObservations);
      const completed = observations.messages.filter((message) => message.type === 'done');
      expect(completed).toHaveLength(4);
      expect(completed.every((message) => message.stats.gpuActiveMs > 0)).toBe(true);
      expect(completed.every((message) => message.stats.engine.includes('WebGPU'))).toBe(true);
      if (cpuPercent === 0) {
        expect(cpuScripts).toHaveLength(0);
        expect(completed.every((message) => message.stats.cpuActiveMs === 0)).toBe(true);
        expect(completed.every((message) => !message.stats.engine.startsWith('CPU'))).toBe(true);
      } else {
        expect(cpuScripts.length).toBeGreaterThan(0);
        expect(completed.every((message) => message.stats.cpuActiveMs > 0)).toBe(true);
        expect(completed.every((message) => message.stats.engine.startsWith('CPU + WebGPU'))).toBe(true);
      }
      expect(observations.created).toBeGreaterThan(0);
      expect(observations.terminated).toBe(observations.created);
      const video = page.getByTestId('final-video');
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
      const metadata = await video.evaluate((node) => {
        const video = node as HTMLVideoElement;
        return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      });
      expect(metadata).toMatchObject({ width: 320, height: 180 });
      expect(metadata.duration).toBeCloseTo(4 / 24, 1);
      await video.evaluate((node) => { const video = node as HTMLVideoElement; video.muted = true; return video.play(); });
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: '영상 다운로드', exact: true }).click();
      const download = await downloadEvent;
      const bytes = await readFile((await download.path())!);
      expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
      expect(errors).toEqual([]);
      const evidencePath = testInfo.outputPath('gpu-rendering-evidence.json');
      await writeFile(evidencePath, JSON.stringify({
        cpuPercent, gpuPercent: 50, frames: completed, cpuWorkerScriptRequests: cpuScripts.length,
        metadata, mp4Bytes: bytes.length, job: (latest as AnimationSnapshot | null)?.job, errors,
      }, null, 2));
      await testInfo.attach('gpu-rendering-evidence', { contentType: 'application/json', path: evidencePath });

      if (cpuPercent === 0) {
        // A live GPU budget change must revoke the existing lease and stop the coordinator before applying 0%.
        await configure(page, 12, 1280, 720, 32);
        await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
        await page.getByRole('button', { name: '연산 참여', exact: true }).click();
        await expect(page.getByTestId('worker-state')).toContainText('계산 중');
        await page.getByTestId('resource-gpuPercent').fill('0');
        await expect(page.getByTestId('resource-gpu-enabled')).toHaveText('꺼짐');
        await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeDisabled();
        await expect.poll(async () => page.evaluate(() => {
          const state = (globalThis as unknown as { resourceObservations: ResourceObservations }).resourceObservations;
          return state.created - state.terminated;
        })).toBe(0);
        await expect.poll(() => latest?.participants.find((participant) => participant.id === latest?.selfId)?.consented).toBe(false);
        await page.getByRole('button', { name: '작업 취소', exact: true }).click();
        await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'cancelled');
        expect(errors).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  });
}
