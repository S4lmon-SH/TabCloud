import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AnimationAssignment, AnimationSettings, AnimationSnapshot } from '../../packages/shared/src/index';
import { renderAnimationFrame } from '../../packages/compute/src/index';

function observe(page: Page) {
  const state = { workers: 0, errors: [] as string[], snapshot: null as AnimationSnapshot | null, assignments: [] as AnimationAssignment[], pixels: new Map<string, Buffer>() };
  page.on('worker', () => { state.workers += 1; });
  page.on('pageerror', (error) => state.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/result?')) {
      const data = request.postDataBuffer();
      if (data) state.pixels.set(new URL(request.url()).searchParams.get('taskId')!, data);
    }
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/animation/rooms/') || !response.ok()) return;
    try {
      if (response.url().endsWith('/state')) state.snapshot = await response.json();
      if (response.url().endsWith('/task')) {
        const { assignment } = await response.json();
        if (assignment) state.assignments.push(assignment);
      }
    } catch { /* Page closure can interrupt an in-flight response. */ }
  });
  return state;
}

async function makeRoom(page: Page) {
  await page.goto('/animation');
  await page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\//);
  await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
  return page.getByTestId('invite-link').inputValue();
}

async function configure(page: Page, value: AnimationSettings) {
  await page.getByText('직접 설정', { exact: true }).click();
  for (const [name, amount] of [['너비', value.width], ['높이', value.height], ['프레임 수', value.frames], ['샘플 수', value.samples], ['반사 횟수', value.bounces]] as const) {
    await page.getByLabel(name, { exact: true }).fill(String(amount));
  }
  await page.getByText('직접 설정', { exact: true }).click();
}

async function complete(page: Page) {
  await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'completed', { timeout: 90000 });
  await expect(page.getByRole('button', { name: '영상 다운로드', exact: true })).toBeEnabled();
}

test('three consenting browsers render real independent 3D frames, then download and play the assembled MP4', async ({ browser, page }, testInfo) => {
  const config: AnimationSettings = { width: 160, height: 96, frames: 12, fps: 24, samples: 2, bounces: 2 };
  const contexts: BrowserContext[] = [];
  const host = observe(page);
  try {
    const invite = await makeRoom(page);
    let uploadBusyOnce = false;
    await page.route('**/api/animation/rooms/*/result?*', async (route) => {
      if (!uploadBusyOnce) {
        uploadBusyOnce = true;
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'UPLOAD_BUSY', message: '다른 프레임을 저장하고 있어요.' }) });
      } else await route.continue();
    });
    await expect(page.getByTestId('animation-preset-demo')).toHaveAttribute('aria-pressed', 'true');
    await configure(page, config);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.getByRole('button', { name: '초대 링크 복사', exact: true }).click();
    await expect(page.getByTestId('invite-link')).toBeVisible();
    await expect(page.getByTestId('invite-link')).toHaveValue(/#invite=/);
    for (let n = 0; n < 2; n++) contexts.push(await browser.newContext());
    const peers = await Promise.all(contexts.map((context) => context.newPage()));
    const states = [host, ...peers.map(observe)];
    await Promise.all(peers.map((peer) => peer.goto(invite)));
    await expect.poll(() => host.snapshot?.participants.filter((p) => p.connected).length).toBe(3);
    for (const peer of peers) await expect(peer.getByRole('button', { name: '렌더 시작', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
    await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'rendering');
    expect(states.every((state) => state.workers === 0 && state.assignments.length === 0)).toBe(true);
    await Promise.all([page, ...peers].map((peer) => peer.getByRole('button', { name: '연산 참여', exact: true }).click()));
    await complete(page);
    await expect.poll(() => host.snapshot?.job?.status).toBe('completed');
    const job = host.snapshot!.job!;
    expect(job.completedFrames).toBe(config.frames);
    expect(job.frames.sort((a, b) => a - b)).toEqual(Array.from({ length: config.frames }, (_, i) => i));
    for (const state of states) {
      expect(state.workers).toBeGreaterThan(0);
      expect(state.pixels.size).toBeGreaterThan(0);
      for (const assignment of state.assignments) {
        const pixels = state.pixels.get(assignment.task.taskId);
        if (pixels) expect(pixels.equals(Buffer.from(renderAnimationFrame(assignment.task)))).toBe(true);
      }
      expect(state.errors).toEqual([]);
    }
    expect(host.snapshot!.participants.every((p) => p.completedFrames > 0)).toBe(true);
    expect(host.snapshot!.participants.reduce((sum, p) => sum + p.completedFrames, 0)).toBe(config.frames);
    const video = page.getByTestId('final-video');
    await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    const meta = await video.evaluate((node) => { const v = node as HTMLVideoElement; return { width: v.videoWidth, height: v.videoHeight, duration: v.duration }; });
    expect(meta.width).toBe(config.width);
    expect(meta.height).toBe(config.height);
    expect(meta.duration).toBeCloseTo(config.frames / config.fps, 1);
    await video.evaluate((node) => (node as HTMLVideoElement).play());
    await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '영상 다운로드', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    const movie = await readFile((await download.path())!);
    expect(movie.subarray(4, 8).toString()).toBe('ftyp');
    expect(movie.length).toBe(job.videoBytes);
    await page.screenshot({ path: testInfo.outputPath('animation-completed.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('animation-mobile.png'), fullPage: true });
    await testInfo.attach('actual-frame-contributions', { body: JSON.stringify({ samePhysicalMachine: true, job, participants: host.snapshot!.participants }, null, 2), contentType: 'application/json' });
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});

test('stopping and closing a browser reassigns its unfinished frame without opting the host into computation', async ({ browser, page }) => {
  const host = observe(page);
  const invite = await makeRoom(page);
  await configure(page, { width: 320, height: 180, frames: 12, fps: 24, samples: 16, bounces: 3 });
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const [leaving, remaining] = await Promise.all(contexts.map((context) => context.newPage()));
    const stopped = observe(leaving);
    const continuing = observe(remaining);
    await Promise.all([leaving.goto(invite), remaining.goto(invite)]);
    await leaving.getByRole('button', { name: '연산 참여', exact: true }).click();
    await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
    await expect.poll(() => stopped.assignments.length).toBeGreaterThan(0);
    await leaving.getByRole('button', { name: '연산 중단', exact: true }).click();
    await expect.poll(() => leaving.workers().length).toBe(0);
    await expect.poll(() => host.snapshot?.job?.retries ?? 0).toBeGreaterThan(0);
    const count = stopped.assignments.length;
    await leaving.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect.poll(() => stopped.assignments.length).toBeGreaterThan(count);
    await contexts[0].close();
    await remaining.getByRole('button', { name: '연산 참여', exact: true }).click();
    await complete(page);
    await expect.poll(() => host.snapshot?.job?.status).toBe('completed');
    expect(host.workers).toBe(0);
    expect(host.snapshot!.job!.retries).toBeGreaterThanOrEqual(2);
    expect(continuing.assignments.some((next) => stopped.assignments.some((old) => next.task.taskId === old.task.taskId && next.attemptId !== old.attemptId))).toBe(true);
    expect(host.errors).toEqual([]);
    expect(continuing.errors).toEqual([]);
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});

test('host cancellation terminates real Workers and never exposes an incomplete video', async ({ page }) => {
  const state = observe(page);
  await makeRoom(page);
  await configure(page, { width: 640, height: 360, frames: 24, fps: 24, samples: 8, bounces: 3 });
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  await expect.poll(() => state.assignments.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '작업 취소', exact: true }).click();
  await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'cancelled');
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(page.getByRole('button', { name: '영상 다운로드', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('final-video')).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('delayed state and consent responses cannot undo a new job or restart CPU after disconnect', async ({ page }) => {
  const observed = observe(page);
  await makeRoom(page);
  let releaseState!: () => void;
  const stateGate = new Promise<void>((resolve) => { releaseState = resolve; });
  let stateHeld = false;
  await page.route('**/api/animation/rooms/*/state', async (route) => {
    if (stateHeld) { await route.continue(); return; }
    const response = await route.fetch(); stateHeld = true;
    await stateGate; await route.fulfill({ response });
  });
  await expect.poll(() => stateHeld).toBe(true);
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'rendering');
  releaseState();
  await expect.poll(() => observed.snapshot?.job?.status).toBe('rendering');
  await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'rendering');

  let releaseConsent!: () => void;
  const consentGate = new Promise<void>((resolve) => { releaseConsent = resolve; });
  let consentHeld = false;
  await page.route('**/api/animation/rooms/*/consent', async (route) => {
    if (!route.request().postDataJSON()?.enabled || consentHeld) { await route.continue(); return; }
    const response = await route.fetch(); consentHeld = true;
    await consentGate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await expect.poll(() => consentHeld).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  releaseConsent();
  await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
  await expect.poll(() => observed.snapshot?.participants.find((p) => p.id === observed.snapshot?.selfId)?.consented).toBe(false);
  expect(observed.workers).toBe(0);
  await page.getByRole('button', { name: '작업 취소', exact: true }).click();
});
