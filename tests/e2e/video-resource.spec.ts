import { expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoSnapshot } from '../../packages/shared/src/index';
import { makeVideoFixture } from '../helpers/video-fixture';

async function createRoom(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  const observed = { workers: 0, sourceRequests: 0, snapshot: null as VideoSnapshot | null, errors: [] as string[] };
  page.on('worker', () => { observed.workers += 1; });
  page.on('pageerror', (error) => observed.errors.push(error.message));
  page.on('request', (request) => { if (request.url().includes('/source/') && request.url().includes('.rgba?')) observed.sourceRequests += 1; });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/video/rooms/') || !response.ok() || !/\/(state|consent|start|cancel|upload)$/.test(response.url())) return;
    try {
      const snapshot = await response.json() as VideoSnapshot;
      if (!observed.snapshot || snapshot.revision > observed.snapshot.revision) observed.snapshot = snapshot;
    } catch { /* A closed page can interrupt polling. */ }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/video\//);
  await expect(page.getByTestId('video-upload')).toBeEnabled();
  return observed;
}

test('uploaded-video consent revoked during a delayed opt-in cannot start workers or download source frames', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-video-resource-'));
  let releaseConsent = () => {};
  let releaseCleanup = () => {};
  try {
    const observed = await createRoom(page);
    await page.getByTestId('video-upload').setInputFiles(makeVideoFixture(directory, 6));
    await expect(page.getByTestId('video-source-status')).toHaveAttribute('data-status', 'ready');
    await page.getByRole('button', { name: '처리 시작', exact: true }).click();
    const gate = new Promise<void>((resolve) => { releaseConsent = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let held = false;
    let withdrawals = 0;
    let cleanupHeld = false;
    await page.route('**/api/video/rooms/*/consent', async (route) => {
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
    const participate = page.getByRole('button', { name: '연산 참여', exact: true });
    await participate.click();
    await expect.poll(() => held).toBe(true);
    await page.getByTestId('resource-cpuPercent').press('ArrowRight');
    await expect(page.getByTestId('resource-cpuPercent')).toHaveValue('30');
    await expect.poll(() => withdrawals).toBe(1);
    releaseConsent();
    await expect.poll(() => cleanupHeld).toBe(true);
    await expect(participate).toBeDisabled();
    expect(observed.workers).toBe(0);
    expect(observed.sourceRequests).toBe(0);
    releaseCleanup();
    await expect(participate).toBeEnabled();
    await expect.poll(() => observed.snapshot?.participants.find((p) => p.id === observed.snapshot?.selfId)?.consented).toBe(false);
    const revision = observed.snapshot!.revision;
    await expect.poll(() => observed.snapshot?.revision ?? 0).toBeGreaterThan(revision + 2);
    expect(observed.workers).toBe(0);
    expect(observed.sourceRequests).toBe(0);
    expect(observed.errors).toEqual([]);
    await page.getByRole('button', { name: '작업 취소', exact: true }).click();
  } finally { releaseConsent(); releaseCleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('replacement upload failure and cancellation preserve the selected source and recover cleanly', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-video-resource-'));
  let releaseUpload = () => {};
  let releaseCancel = () => {};
  try {
    const observed = await createRoom(page);
    const fixture = makeVideoFixture(directory, 6);
    const input = page.getByTestId('video-upload');
    await input.setInputFiles(fixture);
    await expect(page.getByTestId('video-source-status')).toHaveAttribute('data-status', 'ready');
    await expect.poll(() => observed.snapshot?.source?.status).toBe('ready');
    const originalId = observed.snapshot!.source!.id;
    await expect(page.getByTestId('source-video')).toBeVisible();
    await mkdir('.qa', { recursive: true });
    await page.screenshot({ path: '.qa/video-studio-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: '.qa/video-studio-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.route('**/api/video/rooms/*/upload', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '영상 형식을 확인해 주세요.' }) }));
    await input.setInputFiles({ name: 'rejected.mp4', mimeType: 'video/mp4', buffer: Buffer.from('invalid test fixture') });
    await expect(page.getByRole('alert')).toHaveText('영상 형식을 확인해 주세요.');
    await expect(input).toBeEnabled();
    await expect(page.getByTestId('source-video')).toHaveCount(0);
    await expect(page.getByAltText('업로드한 원본 영상의 첫 프레임')).toBeVisible();
    expect(observed.snapshot!.source!.id).toBe(originalId);
    await page.unroute('**/api/video/rooms/*/upload');

    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let uploading = false;
    let cancelling = false;
    await page.route('**/api/video/rooms/*/upload', async (route) => {
      uploading = true; await uploadGate;
      await route.abort().catch(() => {});
    });
    await page.route('**/api/video/rooms/*/cancel', async (route) => {
      const response = await route.fetch(); cancelling = true;
      await cancelGate; await route.fulfill({ response });
    });
    await input.setInputFiles(fixture);
    await expect.poll(() => uploading).toBe(true);
    await page.getByRole('button', { name: '업로드 취소', exact: true }).click();
    await expect.poll(() => cancelling).toBe(true);
    await expect(input).toBeDisabled();
    await expect(page.getByTestId('source-video')).toHaveCount(0);
    releaseUpload(); releaseCancel();
    await expect(input).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(observed.snapshot!.source!.id).toBe(originalId);
    await page.unroute('**/api/video/rooms/*/upload');
    await page.unroute('**/api/video/rooms/*/cancel');
    await input.setInputFiles(fixture);
    await expect.poll(() => observed.snapshot?.source?.id).not.toBe(originalId);
    await expect(page.getByTestId('video-source-status')).toHaveAttribute('data-status', 'ready');
    await expect(page.getByRole('button', { name: '처리 시작', exact: true })).toBeEnabled();
    expect(observed.workers).toBe(0);
    expect(observed.sourceRequests).toBe(0);
    expect(observed.errors).toEqual([]);
  } finally { releaseUpload(); releaseCancel(); await rm(directory, { recursive: true, force: true }); }
});
