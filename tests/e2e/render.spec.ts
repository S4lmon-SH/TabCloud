import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { createTiles, mergeTile, renderTile, checksum } from '../../packages/compute/src/index';
import { DEFAULT_SETTINGS, type RenderSettings, type RoomSnapshot, type ServerMessage } from '../../packages/shared/src/index';

function observe(page: Page) {
  const state = {
    room: undefined as RoomSnapshot | undefined,
    assignments: [] as Extract<ServerMessage, { type: 'task-assigned' }>[],
    accepted: 0,
    workersCreated: 0,
    errors: [] as string[],
  };
  page.on('worker', () => { state.workersCreated += 1; });
  page.on('pageerror', (error) => state.errors.push(error.message));
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    const message = JSON.parse(payload.toString()) as ServerMessage;
    if (message.type === 'room-snapshot') state.room = message.room;
    if (message.type === 'task-assigned') state.assignments.push(message);
    if (message.type === 'task-accepted') state.accepted += 1;
  }));
  return state;
}

async function makeRoom(page: Page) {
  await page.goto('/fractal');
  await page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('connection-status')).toContainText('연결');
  return page.getByTestId('invite-link').inputValue();
}

async function settings(page: Page, value: RenderSettings) {
  await page.getByText('직접 설정', { exact: true }).click();
  await page.getByLabel('너비', { exact: true }).fill(String(value.width));
  await page.getByLabel('높이', { exact: true }).fill(String(value.height));
  await page.getByLabel('반복 횟수', { exact: true }).fill(String(value.maxIterations));
  await page.getByLabel('타일 크기', { exact: true }).selectOption(String(value.tileSize));
  await page.getByLabel('중심 X', { exact: true }).fill(String(value.centerX));
  await page.getByLabel('중심 Y', { exact: true }).fill(String(value.centerY));
  await page.getByLabel('가로 범위', { exact: true }).fill(String(value.span));
}

async function rgba(page: Page) {
  return Buffer.from(await page.getByTestId('render-canvas').evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
  }));
}

function reference(value: RenderSettings) {
  const pixels = new Uint8ClampedArray(value.width * value.height * 4);
  for (const tile of createTiles('reference', value)) mergeTile(pixels, tile, renderTile(tile));
  return Buffer.from(pixels);
}

async function complete(page: Page) {
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'completed', { timeout: 90000 });
  await expect(page.getByRole('button', { name: 'PNG 다운로드', exact: true })).toBeEnabled();
}

test('one and three independent contexts compute identical pixels in real Workers, benchmark and download PNG', async ({ browser, page }, testInfo) => {
  const config = { ...DEFAULT_SETTINGS, width: 512, height: 384, tileSize: 64 as const, maxIterations: 400 };
  const one = observe(page);
  await makeRoom(page);
  await settings(page, config);
  expect(one.workersCreated).toBe(0);
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  await expect.poll(() => one.room?.job?.status).toBe('running');
  // Starting a job as host does not opt that browser into CPU work.
  expect(one.assignments).toHaveLength(0);
  expect(one.workersCreated).toBe(0);
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await complete(page);
  expect(one.workersCreated).toBeGreaterThan(0);
  expect(one.accepted).toBe(48);
  const singlePixels = await rgba(page);
  expect(singlePixels.equals(reference(config))).toBe(true);

  await page.getByRole('button', { name: '단독 실행 측정', exact: true }).click();
  await expect(page.getByText('단독 결과 일치 ✓', { exact: true })).toBeVisible({ timeout: 90000 });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PNG 다운로드', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const decoded = PNG.sync.read(await readFile((await download.path())!));
  expect(decoded.width).toBe(config.width);
  expect(decoded.height).toBe(config.height);
  expect(decoded.data.equals(singlePixels)).toBe(true);

  const contexts: BrowserContext[] = [];
  try {
    for (let index = 0; index < 3; index += 1) contexts.push(await browser.newContext());
    const [host, second, third] = await Promise.all(contexts.map((context) => context.newPage()));
    const states = [host, second, third].map(observe);
    const invite = await makeRoom(host);
    expect(new URL(invite).hash).not.toContain('host');
    await settings(host, config);
    await Promise.all([second.goto(invite), third.goto(invite)]);
    await expect.poll(() => states[0].room?.participants.filter((p) => p.connected).length).toBe(3);
    await expect(second.getByRole('button', { name: '렌더 시작', exact: true })).toHaveCount(0);
    expect(states.every((state) => state.workersCreated === 0)).toBe(true);
    for (const participant of [host, second, third]) {
      await participant.getByRole('button', { name: '연산 참여', exact: true }).click();
    }
    await host.getByRole('button', { name: '렌더 시작', exact: true }).click();
    await complete(host);
    await complete(second);
    await complete(third);
    for (const state of states) {
      expect(state.workersCreated).toBeGreaterThan(0);
      expect(state.accepted).toBeGreaterThan(0);
      expect(state.errors).toEqual([]);
    }
    expect(states.reduce((sum, state) => sum + state.accepted, 0)).toBe(48);
    expect((await rgba(host)).equals(singlePixels)).toBe(true);
    expect((await rgba(second)).equals(singlePixels)).toBe(true);
    expect((await rgba(third)).equals(singlePixels)).toBe(true);
    await host.screenshot({ path: testInfo.outputPath('distributed-completed.png'), fullPage: true });
    await testInfo.attach('measurements', {
      body: JSON.stringify({ sameMachineContexts: true, checksum: checksum(singlePixels), single: one.room?.job, distributed: states[0].room?.job, perContextAccepted: states.map((state) => state.accepted) }, null, 2),
      contentType: 'application/json',
    });
    // Late observers receive and merge every stored tile without starting a Worker.
    const observer = await contexts[0].newPage();
    const observerState = observe(observer);
    await observer.goto(invite);
    await complete(observer);
    expect((await rgba(observer)).equals(singlePixels)).toBe(true);
    expect(observerState.workersCreated).toBe(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
  expect(one.errors).toEqual([]);
});

test('demo presets keep consent explicit and the higher iteration limit runs in a real Worker', async ({ page }, testInfo) => {
  const state = observe(page);
  await makeRoom(page);
  // LAN HTTP browsers may not expose Clipboard API; manual sharing must remain usable.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.getByRole('button', { name: '초대 링크 복사', exact: true }).click();
  await expect(page.getByTestId('invite-link')).toBeVisible();
  await expect(page.getByTestId('invite-link')).toHaveValue(/#invite=/);
  await expect(page.getByTestId('preset-demo')).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('직접 설정', { exact: true }).click();
  await expect(page.getByLabel('너비', { exact: true })).toHaveValue('2048');
  await expect(page.getByLabel('반복 횟수', { exact: true })).toHaveValue('8000');
  await page.getByTestId('preset-heavy').click();
  await expect(page.getByLabel('반복 횟수', { exact: true })).toHaveValue('20000');
  await page.getByTestId('preset-quick').click();
  await expect(page.getByLabel('너비', { exact: true })).toHaveValue('1024');
  await expect(page.getByLabel('반복 횟수', { exact: true })).toHaveValue('500');
  await page.getByTestId('preset-demo').click();
  expect(state.workersCreated).toBe(0);
  // Exercise the real high iteration path at a small image size to keep CI bounded.
  const config = { ...DEFAULT_SETTINGS, width: 128, height: 128, tileSize: 64 as const, maxIterations: 20000 };
  await page.getByText('직접 설정', { exact: true }).click();
  await settings(page, config);
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  await expect.poll(() => state.room?.job?.status).toBe('running');
  expect(state.workersCreated).toBe(0);
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await complete(page);
  expect(state.assignments.length).toBe(4);
  expect(state.accepted).toBe(4);
  expect(state.room?.job?.settings.maxIterations).toBe(20000);
  expect((await rgba(page)).equals(reference(config))).toBe(true);
  await page.getByText('직접 설정', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeVisible();
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('mobile-room.png'), fullPage: true });
  expect(state.errors).toEqual([]);
});

test('withdrawal terminates a Worker and a lost participant lease is recovered by the remaining browser', async ({ browser, page }, testInfo) => {
  const config = { ...DEFAULT_SETTINGS, width: 768, height: 768, tileSize: 128 as const, maxIterations: 2000, centerX: 0, centerY: 0, span: 0.2 };
  const host = observe(page);
  const invite = await makeRoom(page);
  await settings(page, config);
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const [leaving, remaining] = await Promise.all(contexts.map((context) => context.newPage()));
    const leavingState = observe(leaving);
    const remainingState = observe(remaining);
    await Promise.all([leaving.goto(invite), remaining.goto(invite)]);
    await leaving.getByRole('button', { name: '연산 참여', exact: true }).click();
    await remaining.getByRole('button', { name: '연산 참여', exact: true }).click();
    await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
    await expect.poll(() => leavingState.assignments.length).toBeGreaterThan(0);
    await leaving.getByRole('button', { name: '연산 중단', exact: true }).click();
    await expect.poll(() => leaving.workers().length).toBe(0);
    await expect.poll(() => host.room?.job?.retries ?? 0).toBeGreaterThan(0);
    const assignmentsAfterStop = leavingState.assignments.length;
    await expect(leaving.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
    // A new accepted tile elsewhere proves scheduling continued while this browser stayed stopped.
    const acceptedBefore = remainingState.accepted;
    await expect.poll(() => remainingState.accepted).toBeGreaterThan(acceptedBefore);
    expect(leavingState.assignments.length).toBe(assignmentsAfterStop);
    await leaving.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect.poll(() => leavingState.assignments.length).toBeGreaterThan(assignmentsAfterStop);
    await contexts[0].close();
    await complete(page);
    expect(host.room?.job?.retries).toBeGreaterThanOrEqual(2);
    // Inspect every issued lease: closing a browser can race with its next assignment,
    // so the last frame observed before close() is not necessarily the abandoned lease.
    const reassigned = new Set(remainingState.assignments.filter((assignment) =>
      leavingState.assignments.some((previous) => previous.task.taskId === assignment.task.taskId
        && previous.attemptId !== assignment.attemptId)).map((assignment) => assignment.task.taskId));
    // A withdrawn tile may be picked up again by its original browser before
    // that browser closes, so distinct cross-browser recoveries need not be two.
    expect(reassigned.size).toBeGreaterThanOrEqual(1);
    expect(host.room?.events.some((event) => event.message.includes('연결 종료로 미완료 타일'))).toBe(true);
    expect(host.workersCreated).toBe(0);
    expect((await rgba(page)).equals(reference(config))).toBe(true);
    await testInfo.attach('recovery', { body: JSON.stringify(host.room, null, 2), contentType: 'application/json' });
    expect(host.errors).toEqual([]);
    expect(remainingState.errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('host cancellation stops active computation; unavailable rooms explain restart or expiration', async ({ page }) => {
  const state = observe(page);
  await makeRoom(page);
  await settings(page, { ...DEFAULT_SETTINGS, width: 1024, height: 1024, maxIterations: 2000 });
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await page.getByRole('button', { name: '렌더 시작', exact: true }).click();
  await expect.poll(() => state.assignments.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '작업 취소', exact: true }).click();
  await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'cancelled');
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(page.getByRole('button', { name: 'PNG 다운로드', exact: true })).toBeDisabled();
  await page.goto('/room/missing-room#invite=invalid-token');
  await expect(page.getByRole('alert')).toContainText(/만료|재시작|존재하지/);
  expect(state.errors).toEqual([]);
});
