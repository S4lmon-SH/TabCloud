import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoAssignment, VideoSnapshot } from '../../packages/shared/src/index';
import { processVideoFrame } from '../../packages/compute/src/index';
import { makeVideoFixture, checkVideoAudio } from '../helpers/video-fixture';

interface WorkerStats { cpuRows: number; gpuRows: number; gpuFrames: number; gpuDispatches: number; gpuHardware: boolean; adapterName: string | null; gpuTimestampMs: number | null; cpuActiveMs: number; gpuActiveMs: number; trackedBytes: number }
interface WorkerObservation { created: number; terminated: number; done: WorkerStats[] }

async function observe(page: Page) {
  await page.addInitScript(() => {
    const observations: WorkerObservation = { created: 0, terminated: 0, done: [] };
    (globalThis as unknown as { videoWorkers: WorkerObservation }).videoWorkers = observations;
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); observations.created += 1;
        this.addEventListener('message', ({ data }) => { if (data.type === 'done' && data.stats) observations.done.push(data.stats); });
      }
      override terminate() { observations.terminated += 1; super.terminate(); }
    };
  });
  const state = { errors: [] as string[], assignments: [] as VideoAssignment[],
    inputs: new Map<string, Buffer>(), outputs: new Map<string, Buffer>(), pending: [] as Promise<void>[], snapshot: null as VideoSnapshot | null };
  page.on('pageerror', (error) => state.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/result?')) {
      const bytes = request.postDataBuffer();
      if (bytes) state.outputs.set(new URL(request.url()).searchParams.get('taskId')!, bytes);
    }
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/video/rooms/') || !response.ok()) return;
    state.pending.push((async () => {
      if (/\/(state|start|consent|cancel|upload)$/.test(response.url())) {
        const snapshot = await response.json() as VideoSnapshot;
        if (!state.snapshot || snapshot.revision > state.snapshot.revision) state.snapshot = snapshot;
      }
      if (response.url().endsWith('/task')) {
        const { assignment } = await response.json();
        if (assignment) state.assignments.push(assignment);
      }
      if (response.url().includes('/source/') && response.url().includes('.rgba?')) {
        state.inputs.set(new URL(response.url()).searchParams.get('taskId')!, await response.body());
      }
    })().catch(() => { /* Navigation can cancel an outstanding poll. */ }));
  });
  return state;
}

async function upload(page: Page, path: string) {
  await page.getByTestId('video-upload').setInputFiles(path);
  await expect(page.getByTestId('video-source-status')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
}

async function createRoom(page: Page, url = '/') {
  await page.goto(url);
  await page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/video\//);
  await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
  return page.getByTestId('invite-link').inputValue();
}

test('uploaded video is filtered by three consenting browsers with exact pixels and preserved audio', async ({ browser, page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-e2e-video-'));
  const contexts: BrowserContext[] = [];
  try {
    const fixture = makeVideoFixture(directory, 24);
    const host = await observe(page);
    const invite = await createRoom(page);
    await upload(page, fixture);
    await page.getByLabel('밝기', { exact: true }).fill('20');
    for (let n = 0; n < 2; n++) contexts.push(await browser.newContext());
    const peers = await Promise.all(contexts.map((context) => context.newPage()));
    const peerStates = await Promise.all(peers.map(observe));
    await Promise.all(peers.map((peer) => peer.goto(invite)));
    await expect.poll(() => host.snapshot?.participants.filter((peer) => peer.connected).length).toBe(3);
    for (const peer of peers) {
      await expect(peer.getByRole('button', { name: '처리 시작', exact: true })).toHaveCount(0);
      await expect(peer.getByTestId('video-upload')).toHaveCount(0);
    }
    for (const participant of [page, ...peers]) {
      await participant.getByTestId('resource-cpuPercent').fill('25');
      // Headless shell has no hardware adapter. This explicitly permits CPU-only processing.
      const gpu = participant.getByTestId('resource-gpuPercent');
      if (await gpu.isEnabled()) await gpu.fill('0');
    }
    await page.getByRole('button', { name: '처리 시작', exact: true }).click();
    await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'rendering');
    for (const participant of [page, ...peers]) {
      expect(await participant.evaluate(() => (globalThis as unknown as { videoWorkers: WorkerObservation }).videoWorkers.created)).toBe(0);
    }
    expect([host, ...peerStates].every((state) => state.assignments.length === 0 && state.inputs.size === 0)).toBe(true);
    await Promise.all([page, ...peers].map((participant) => participant.getByRole('button', { name: '연산 참여', exact: true }).click()));
    await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'completed', { timeout: 90_000 });
    await expect.poll(() => host.snapshot?.job?.status).toBe('completed');
    const states = [host, ...peerStates];
    let changedFrames = 0;
    for (const state of states) {
      await Promise.all(state.pending);
      expect(state.outputs.size).toBeGreaterThan(0);
      expect(state.errors).toEqual([]);
      for (const assignment of state.assignments) {
        const actual = state.outputs.get(assignment.task.taskId);
        if (!actual) continue;
        const source = state.inputs.get(assignment.task.taskId)!;
        expect(source, 'The frame was fetched from the uploaded source.').toBeTruthy();
        expect(actual.equals(Buffer.from(processVideoFrame(source, assignment.task)))).toBe(true);
        if (!actual.equals(source)) changedFrames += 1;
      }
    }
    expect(changedFrames).toBe(24);
    expect(host.snapshot!.job!.completedFrames).toBe(24);
    expect(host.snapshot!.participants.every((participant) => participant.completedFrames > 0)).toBe(true);
    expect(host.snapshot!.source!.hasAudio).toBe(true);
    const output = page.getByTestId('final-video');
    await expect.poll(() => output.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    expect(await output.evaluate((node) => (node as HTMLVideoElement).videoWidth)).toBe(160);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '영상 다운로드', exact: true }).click();
    const download = await downloadEvent;
    const resultPath = join(directory, 'processed.mp4');
    await download.saveAs(resultPath);
    expect(checkVideoAudio(resultPath).nonSilent).toBe(true);
    const result = await readFile(resultPath);
    expect(result.subarray(4, 8).toString()).toBe('ftyp');
    await testInfo.attach('processed-upload.mp4', { body: result, contentType: 'video/mp4' });
    await page.screenshot({ path: testInfo.outputPath('uploaded-video-completed.png'), fullPage: true });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const cpuPercent of [0, 25]) {
  test(`uploaded video uses actual hardware GPU with CPU ${cpuPercent}%`, async ({ baseURL }, testInfo) => {
    const browser = await chromium.launch({ channel: 'chromium' });
    const directory = await mkdtemp(join(tmpdir(), 'tabcloud-e2e-gpu-video-'));
    try {
      const page = await browser.newPage();
      const state = await observe(page);
      await page.goto(baseURL!);
      const hardware = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        return Boolean(adapter && Reflect.get(adapter.info, 'isFallbackAdapter') === false);
      });
      if (process.env.REQUIRE_WEBGPU === '1') expect(hardware).toBe(true);
      test.skip(!hardware, 'No verified hardware WebGPU adapter. CPU-only upload processing is covered separately.');
      await createRoom(page, baseURL!);
      await upload(page, makeVideoFixture(directory, 8, 320, 180));
      await page.getByTestId('resource-cpuPercent').fill(String(cpuPercent));
      await page.getByTestId('resource-gpuPercent').fill('100');
      await page.getByRole('button', { name: '연산 참여', exact: true }).click();
      await page.getByRole('button', { name: '처리 시작', exact: true }).click();
      await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'completed', { timeout: 90_000 });
      await expect.poll(() => state.snapshot?.job?.status).toBe('completed');
      await Promise.all(state.pending);
      const observed = await page.evaluate(() => (globalThis as unknown as { videoWorkers: WorkerObservation }).videoWorkers);
      expect(observed.done).toHaveLength(8);
      expect(observed.done.every((stats) => stats.gpuHardware && stats.gpuRows > 0 && stats.gpuDispatches > 0)).toBe(true);
      expect(observed.done.at(-1)!.gpuFrames).toBe(8);
      expect(observed.done.every((stats) => cpuPercent ? stats.cpuRows > 0 : stats.cpuRows === 0 && stats.cpuActiveMs === 0)).toBe(true);
      expect(state.snapshot!.participants[0]!.gpuFrames).toBe(8);
      for (const assignment of state.assignments) {
        const actual = state.outputs.get(assignment.task.taskId);
        if (actual) expect(actual.equals(Buffer.from(processVideoFrame(state.inputs.get(assignment.task.taskId)!, assignment.task)))).toBe(true);
      }
      expect(state.errors).toEqual([]);
      const metrics = { cpuPercent, source: state.snapshot!.source, job: state.snapshot!.job, worker: observed };
      await writeFile(testInfo.outputPath('hardware-video-metrics.json'), JSON.stringify(metrics, null, 2));
      await testInfo.attach('hardware GPU measurements', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('changing resource limits immediately stops uploaded-video work and requires consent to resume', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-e2e-video-stop-'));
  try {
    const state = await observe(page);
    await createRoom(page);
    await upload(page, makeVideoFixture(directory, 12, 640, 360));
    const gpu = page.getByTestId('resource-gpuPercent');
    if (await gpu.isEnabled()) await gpu.fill('0');
    await page.getByTestId('resource-cpuPercent').fill('5');
    await page.getByTestId('resource-ramPercent').fill('0');
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeDisabled();
    await page.getByTestId('resource-ramPercent').fill('10');
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '처리 시작', exact: true }).click();
    await page.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect.poll(() => state.assignments.length).toBeGreaterThan(0);
    await page.getByTestId('resource-cpuPercent').fill('0');
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeDisabled();
    await expect.poll(() => state.snapshot?.participants.find((p) => p.id === state.snapshot?.selfId)?.consented).toBe(false);
    await expect.poll(async () => page.evaluate(() => {
      const workers = (globalThis as unknown as { videoWorkers: WorkerObservation }).videoWorkers;
      return workers.created === workers.terminated;
    })).toBe(true);
    await page.getByTestId('resource-cpuPercent').fill('25');
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
    await expect.poll(() => state.snapshot?.job?.status).toBe('rendering');
    await page.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'completed', { timeout: 90_000 });
    // Same original can be processed again without another upload.
    const sourceId = state.snapshot?.source?.id;
    await page.getByLabel('밝기', { exact: true }).fill('-10');
    await page.getByRole('button', { name: '처리 시작', exact: true }).click();
    await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'rendering');
    await page.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect(page.getByRole('button', { name: '연산 중단', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '작업 취소', exact: true }).click();
    await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'cancelled');
    await expect.poll(() => state.snapshot?.job?.status).toBe('cancelled');
    expect(state.snapshot?.source?.id).toBe(sourceId);
    expect(state.errors).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
