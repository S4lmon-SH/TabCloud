import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VideoOutputSettings, VideoSnapshot } from '../../packages/shared/src/index';

const requireServer = createRequire(resolve('apps/server/package.json'));
const ffmpeg = process.env.FFMPEG_PATH || requireServer('ffmpeg-static') as string;
const publicDeployment = Boolean(process.env.E2E_BASE_URL);
test.describe.configure({ timeout: publicDeployment ? 360_000 : 120_000 });

function fixture(directory: string, name: string, width: number, height: number, fps: string, frames: number) {
  const path = join(directory, name);
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '2', path],
  { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return path;
}

async function setup(page: Page, file: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '방 만들기', exact: true }).click();
  await expect(page).toHaveURL(/\/video\//, { timeout: publicDeployment ? 100_000 : 15_000 });
  await expect(page.getByTestId('video-upload')).toBeEnabled();
  await page.getByTestId('video-upload').setInputFiles(file);
  await expect(page.getByTestId('video-source-status')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  await page.getByTestId('resource-cpuPercent').fill('25');
  if (await page.getByTestId('resource-gpuPercent').isEnabled()) await page.getByTestId('resource-gpuPercent').fill('0');
}

async function render(page: Page) {
  await page.getByRole('button', { name: '처리 시작', exact: true }).click();
  await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'rendering');
  await page.getByRole('button', { name: '연산 참여', exact: true }).click();
  await expect(page.getByTestId('video-status')).toHaveAttribute('data-status', 'completed', { timeout: publicDeployment ? 180_000 : 90_000 });
  await expect(page.getByRole('button', { name: '영상 다운로드', exact: true })).toBeEnabled();
}

test('MKV source retains fractional fps and supports different output profiles without reuploading', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-quality-'));
  const starts: { settings: unknown; output: VideoOutputSettings }[] = [];
  let uploads = 0;
  const completed: VideoSnapshot[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/upload')) uploads++;
    if (request.method() === 'POST' && request.url().endsWith('/start')) starts.push(request.postDataJSON());
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/state') && response.ok()) void response.json().then((snapshot: VideoSnapshot) => {
      if (snapshot.job?.status === 'completed' && !completed.some((previous) => previous.job?.id === snapshot.job?.id)) completed.push(snapshot);
    }).catch(() => {});
  });
  try {
    await setup(page, fixture(directory, 'fractional.mkv', 160, 96, '30000/1001', 6));
    await expect(page.getByTestId('video-source-info')).toContainText('29.97fps');
    await expect(page.getByLabel('출력 해상도', { exact: true })).toHaveValue('1080p');
    await expect(page.getByLabel('프레임률', { exact: true })).toHaveValue('source');
    await expect(page.getByTestId('video-output-summary')).toContainText('160 × 96 · 29.97fps');
    await render(page);
    await expect.poll(() => completed.length).toBe(1);
    expect(completed[0].job!.fps).toBeCloseTo(30000 / 1001, 2);
    await page.getByLabel('프레임률', { exact: true }).selectOption('60');
    await page.getByLabel('출력 화질', { exact: true }).selectOption('balanced');
    await expect(page.getByTestId('video-output-summary')).toContainText('60fps');
    await render(page);
    await expect.poll(() => completed.length).toBe(2);
    expect(completed[1].job!.fps).toBe(60);
    expect(completed[1].job!.completedFrames).toBeGreaterThan(completed[0].job!.completedFrames);
    await page.getByLabel('프레임률', { exact: true }).selectOption('30');
    await page.getByLabel('출력 화질', { exact: true }).selectOption('compact');
    await render(page);
    await expect.poll(() => completed.length).toBe(3);
    expect(completed[2].job!.fps).toBe(30);
    expect(starts.map(({ output }) => output)).toEqual([
      { resolution: '1080p', fps: 'source', quality: 'high' },
      { resolution: '1080p', fps: 60, quality: 'balanced' },
      { resolution: '1080p', fps: 30, quality: 'compact' },
    ]);
    expect(uploads).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('portrait output keeps its orientation and changing quality revokes consent', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-portrait-'));
  try {
    await setup(page, fixture(directory, 'portrait.mp4', 1080, 1920, '60', 1));
    await expect(page.getByTestId('video-output-summary')).toContainText('1080 × 1920 · 60fps');
    await page.getByRole('button', { name: '연산 참여', exact: true }).click();
    await expect(page.getByRole('button', { name: '연산 중단', exact: true })).toBeVisible();
    await page.getByLabel('출력 해상도', { exact: true }).selectOption('720p');
    await expect(page.getByTestId('video-output-summary')).toContainText('720 × 1280 · 60fps');
    await expect(page.getByRole('button', { name: '연산 참여', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '연산 중단', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(page.getByLabel('출력 해상도', { exact: true })).toBeVisible();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a longer timeline renders at most 120 frame buttons while work advances in windows', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabcloud-timeline-'));
  try {
    await setup(page, fixture(directory, 'timeline.avi', 96, 64, '60', 126));
    await expect(page.getByTestId('frame-grid').getByRole('button')).toHaveCount(120);
    await page.getByLabel('노이즈 제거', { exact: true }).fill('0');
    await page.getByLabel('선명도', { exact: true }).fill('0');
    await render(page);
    await expect(page.getByTestId('frame-grid').getByRole('button')).toHaveCount(120);
    await expect(page.getByTestId('frame-progress')).toHaveAttribute('data-completed', '126');
    await expect(page.getByRole('button', { name: '프레임 126: 완료', exact: true })).toBeVisible();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
