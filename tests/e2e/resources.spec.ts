import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { renderAnimationFrame } from '../../packages/compute/src/index';
import type { AnimationAssignment, AnimationSettings, AnimationSnapshot } from '../../packages/shared/src/index';

async function deviceHints(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
}

function observe(page: Page) {
  const state = { workers: 0, errors: [] as string[], snapshot: null as AnimationSnapshot | null, assignments: [] as AnimationAssignment[], progress: 0, uploads: new Map<string, Buffer>() };
  page.on('worker', () => { state.workers += 1; });
  page.on('pageerror', (error) => state.errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/progress') && request.postDataJSON()?.rows > 0) state.progress += 1;
    if (request.method() === 'PUT' && request.url().includes('/result?')) {
      const pixels = request.postDataBuffer();
      if (pixels) state.uploads.set(new URL(request.url()).searchParams.get('taskId')!, pixels);
    }
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/animation/rooms/') || !response.ok()) return;
    try {
      if (/\/(state|consent|start|cancel)$/.test(response.url())) {
        const snapshot = await response.json() as AnimationSnapshot;
        if (!state.snapshot || snapshot.revision > state.snapshot.revision) state.snapshot = snapshot;
      }
      if (response.url().endsWith('/task')) {
        const { assignment } = await response.json();
        if (assignment) state.assignments.push(assignment);
      }
    } catch { /* Page closure can interrupt requests. */ }
  });
  return state;
}

async function makeRoom(page: Page) {
  await deviceHints(page);
  await page.goto('/');
  await page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\//);
  await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
  return page.getByTestId('invite-link').inputValue();
}

async function setPercent(slider: Locator, value: number) {
  await slider.focus();
  await slider.press('Home');
  for (let current = 0; current < value; current += 5) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(value));
}

async function configure(page: Page, settings: AnimationSettings) {
  await page.getByText('직접 설정', { exact: true }).click();
  for (const [label, value] of [['너비', settings.width], ['높이', settings.height], ['프레임 수', settings.frames], ['샘플 수', settings.samples], ['반사 횟수', settings.bounces]] as const) await page.getByLabel(label, { exact: true }).fill(String(value));
  await page.getByText('직접 설정', { exact: true }).click();
}

test('resource limits block zero budgets, persist in this browser, and stay independent between participants', async ({ browser, page }) => {
  const observed = observe(page);
  const invite = await makeRoom(page);
  const cpu = page.getByTestId('resource-cpuPercent');
  const ram = page.getByTestId('resource-ramPercent');
  const participate = page.getByRole('button', { name: '연산 참여', exact: true });
  await expect(cpu).toHaveValue('25');
  await expect(page.getByTestId('resource-cpu-workers')).toHaveText('1개');
  await expect(page.getByTestId('resource-gpuPercent')).toBeDisabled();
  await setPercent(cpu, 0);
  await expect(participate).toBeDisabled();
  await expect(page.getByText('CPU 또는 GPU 사용 비율을 높여 주세요.', { exact: true })).toBeVisible();
  await setPercent(cpu, 40);
  await setPercent(ram, 0);
  await expect(participate).toBeDisabled();
  await expect(page.getByTestId('resource-ram-budget')).toHaveText('0 MiB');
  await setPercent(ram, 20);
  await expect(participate).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('resource-cpuPercent')).toHaveValue('40');
  await expect(page.getByTestId('resource-ramPercent')).toHaveValue('20');
  await expect(participate).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(observed.workers).toBe(0);

  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await deviceHints(peer);
    await peer.goto(invite);
    await expect(peer.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
    await expect(peer.getByTestId('resource-cpuPercent')).toHaveValue('25');
    await expect(peer.getByTestId('resource-ramPercent')).toHaveValue('10');
    await expect(peer.getByTestId('resource-gpuPercent')).toHaveValue('0');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('resource-controls')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await mkdir('.qa', { recursive: true });
    await page.screenshot({ path: '.qa/resource-mobile.png', fullPage: true });
    expect(observed.errors).toEqual([]);
  } finally { await context.close(); }
});

test('changing a limit stops actual CPU work and withdraws consent until explicitly joining again', async ({ page }) => {
  const observed = observe(page);
  await makeRoom(page);
  await configure(page, { width: 640, height: 360, frames: 3, fps: 24, samples: 16, bounces: 3 });
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await expect.poll(() => observed.progress).toBeGreaterThan(0);
  await expect.poll(() => page.workers().length).toBeGreaterThan(0);
  await setPercent(page.getByTestId('resource-cpuPercent'), 50);
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
  await expect.poll(() => observed.snapshot?.participants.find((p) => p.id === observed.snapshot?.selfId)?.consented).toBe(false);
  await expect.poll(() => observed.snapshot?.job?.retries ?? 0).toBeGreaterThan(0);
  const stoppedWorkers = observed.workers;
  const stoppedAssignments = observed.assignments.length;
  const revision = observed.snapshot!.revision;
  await expect.poll(() => observed.snapshot?.revision ?? 0).toBeGreaterThan(revision + 2);
  expect(observed.workers).toBe(stoppedWorkers);
  expect(observed.assignments.length).toBe(stoppedAssignments);

  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await expect(page.getByTestId('resource-cpu-workers')).toHaveText('2개');
  await expect(page.getByTestId('animation-status')).toHaveAttribute('data-status', 'completed', { timeout: 90_000 });
  await expect.poll(() => page.workers().length).toBe(0);
  await expect.poll(() => observed.snapshot?.job?.status).toBe('completed');
  expect(observed.snapshot!.job!.completedFrames).toBe(3);
  expect(observed.workers).toBeGreaterThan(stoppedWorkers);
  expect(observed.uploads.size).toBe(3);
  for (const assignment of observed.assignments) {
    const pixels = observed.uploads.get(assignment.task.taskId);
    if (pixels) expect(pixels.equals(Buffer.from(renderAnimationFrame(assignment.task)))).toBe(true);
  }
  expect(observed.errors).toEqual([]);
});

test('a limit change during delayed consent never creates workers from the stale response', async ({ page }) => {
  const observed = observe(page);
  await makeRoom(page);
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  let releaseConsent!: () => void;
  const gate = new Promise<void>((resolve) => { releaseConsent = resolve; });
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let held = false;
  let withdrawals = 0;
  let cleanupHeld = false;
  await page.route('**/api/animation/rooms/*/consent', async (route) => {
    if (!route.request().postDataJSON()?.enabled) {
      withdrawals += 1;
      if (withdrawals === 2) {
        const response = await route.fetch(); cleanupHeld = true;
        await cleanupGate; await route.fulfill({ response });
      } else await route.continue();
      return;
    }
    if (held) { await route.continue(); return; }
    const response = await route.fetch(); held = true;
    await gate; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    // One limit change revokes consent; the stale opt-in requires another cleanup.
    await page.getByTestId('resource-cpuPercent').press('ArrowRight');
    await expect(page.getByTestId('resource-cpuPercent')).toHaveValue('30');
    await expect.poll(() => withdrawals).toBe(1);
    releaseConsent();
    await expect.poll(() => cleanupHeld).toBe(true);
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeDisabled();
    expect(observed.workers).toBe(0);
    releaseCleanup();
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
    await expect.poll(() => observed.snapshot?.participants.find((p) => p.id === observed.snapshot?.selfId)?.consented).toBe(false);
    const revision = observed.snapshot!.revision;
    await expect.poll(() => observed.snapshot?.revision ?? 0).toBeGreaterThan(revision + 2);
    expect(observed.workers).toBe(0);
    expect(observed.assignments).toEqual([]);
    expect(observed.errors).toEqual([]);
    await page.getByRole('button', { name: '작업 취소', exact: true }).click();
  } finally { releaseConsent(); releaseCleanup(); }
});
