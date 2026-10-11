import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import ffmpegStatic from 'ffmpeg-static';
import { processVideoFrame } from '@tabcloud/compute';
import { DEFAULT_VIDEO_PROCESSING, VIDEO_LIMITS, type VideoAssignment, type VideoJoinResult, type VideoRoomCreated, type VideoSnapshot } from '@tabcloud/shared';
import { buildServer, type TabCloudServer } from './app.js';

const servers: TabCloudServer[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map((app) => app.close())); });
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic!;
function clip(duration = 0.125, audio = true, size = '64x64', fps = 24): Buffer {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), '-t', String(duration),
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []),
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { windowsHide: true, maxBuffer: 2_000_000 });
  expect(result.status, result.stderr.toString()).toBe(0); return result.stdout;
}
async function waitFor(predicate: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for video.'); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function fixture(existing?: TabCloudServer) {
  let now = 1_000_000;
  const app = existing ?? await buildServer({ now: () => now, sweepIntervalMs: 1_000_000, heartbeatTimeoutMs: 1_000_000, maxMessagesPerSecond: 10_000 });
  if (!existing) servers.push(app);
  const create = await app.inject({ method: 'POST', url: '/api/video/rooms', payload: {} });
  expect(create.statusCode, create.body).toBe(201);
  const room = create.json<VideoRoomCreated>(); const base = `/api/video/rooms/${room.roomId}`;
  const join = async (host = false) => {
    const response = await app.inject({ method: 'POST', url: `${base}/join`, payload: { inviteToken: room.inviteToken, name: host ? 'Host' : 'Peer', ...(host ? { hostToken: room.hostToken } : {}) } });
    expect(response.statusCode, response.body).toBe(200); return response.json<VideoJoinResult>();
  };
  const host = await join(true); const headers = (peer = host) => ({ authorization: `Bearer ${peer.participantToken}` });
  const post = (suffix: string, payload: unknown = {}, peer = host) => app.inject({ method: 'POST', url: base + suffix, headers: headers(peer), payload: payload as any });
  const state = async (peer = host) => (await app.inject({ url: base + '/state', headers: headers(peer) })).json<VideoSnapshot>();
  const upload = (bytes = clip(), peer = host) => app.inject({ method: 'PUT', url: base + '/upload', headers: { ...headers(peer), 'content-type': 'application/octet-stream' }, payload: bytes });
  const prepare = async (bytes = clip()) => {
    const response = await upload(bytes); expect(response.statusCode, response.body).toBe(202);
    await waitFor(async () => (await state()).source?.status !== 'preparing');
    const snapshot = await state(); expect(snapshot.source?.status, JSON.stringify(snapshot.source)).toBe('ready'); return snapshot;
  };
  const start = async () => { const response = await post('/start', { settings: DEFAULT_VIDEO_PROCESSING }); expect(response.statusCode, response.body).toBe(200); return response.json<VideoSnapshot>(); };
  const assignment = async (peer = host) => {
    let selected: VideoAssignment | null = null;
    await waitFor(async () => {
      const response = await post('/task', {}, peer); expect(response.statusCode, response.body).toBe(200);
      selected = response.json<{ assignment: VideoAssignment | null }>().assignment;
      return selected !== null;
    });
    return selected! as VideoAssignment;
  };
  const sourceUrl = (job: VideoAssignment) => `${base}/source/${job.task.jobId}/${job.task.frameIndex}.rgba?${new URLSearchParams({ taskId: job.task.taskId, attemptId: job.attemptId })}`;
  const source = (job: VideoAssignment, peer = host) => app.inject({ url: sourceUrl(job), headers: headers(peer) });
  const result = (job: VideoAssignment, pixels: Buffer, peer = host, engine = 'cpu') => app.inject({ method: 'PUT', url: `${base}/result?${new URLSearchParams({ jobId: job.task.jobId, taskId: job.task.taskId, attemptId: job.attemptId, computeMs: '10', engine })}`, headers: { ...headers(peer), 'content-type': 'application/octet-stream' }, payload: pixels });
  return { app, base, host, headers, post, state, join, upload, prepare, start, assignment, source, sourceUrl, result, advance: (ms: number) => { now += ms; } };
}

describe('uploaded video edge-processing API', () => {
  it('decodes uploaded audio/video, distributes real source frames, validates browser filtering and retains audio in MP4', async () => {
    const f = await fixture(); const peer = await f.join();
    const initial = await f.prepare();
    expect(initial.source).toMatchObject({ width: 64, height: 64, fps: 24, hasAudio: true });
    expect(initial.source!.frames).toBeGreaterThanOrEqual(3);
    const job = await f.start(); await f.post('/consent', { enabled: true }); await f.post('/consent', { enabled: true }, peer);
    let processed = 0;
    while (true) {
      await waitFor(async () => { const job = (await f.state()).job!; return job.phase === 'processing' || job.status !== 'rendering'; });
      if ((await f.state()).job?.status !== 'rendering') break;
      const participant = processed % 2 ? peer : f.host;
      const assignment = await f.assignment(participant);
      const input = await f.source(assignment, participant); expect(input.statusCode, input.body).toBe(200);
      expect(input.rawPayload).toHaveLength(64 * 64 * 4);
      const output = Buffer.from(processVideoFrame(input.rawPayload, assignment.task));
      expect(output.equals(input.rawPayload)).toBe(false);
      const result = await f.result(assignment, output, participant, processed % 2 ? 'gpu' : 'cpu');
      expect(result.statusCode, result.body).toBe(200); processed += 1;
    }
    await waitFor(async () => (await f.state()).job?.status !== 'encoding');
    const snapshot = await f.state(); expect(snapshot.job?.status, JSON.stringify(snapshot.job)).toBe('completed');
    expect(snapshot.job!.completedFrames).toBe(processed);
    expect(snapshot.job!.totalFrames).toBe(processed); expect(snapshot.job!.frameCountExact).toBe(true);
    expect(snapshot.participants.reduce((sum, p) => sum + p.cpuFrames + p.gpuFrames, 0)).toBe(processed);
    expect(snapshot.participants.every((p) => !p.consented)).toBe(true);
    const video = await f.app.inject({ url: `${f.base}/video/${job.job!.id}.mp4`, headers: f.headers() }); expect(video.statusCode).toBe(200);
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', 'pipe:0', '-map', '0:a:0', '-f', 'null', '-'], { input: video.rawPayload, windowsHide: true });
    expect(probe.status, probe.stderr.toString()).toBe(0); expect(probe.stderr.toString()).toContain('Audio: aac');
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', 'pipe:1'], { input: video.rawPayload, maxBuffer: 1_000_000, windowsHide: true });
    expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBe(processed * 64 * 64 * 4);
    const preview = await f.app.inject({ url: `${f.base}/preview/${job.job!.id}/0.png`, headers: f.headers(peer) }); expect(preview.statusCode).toBe(200); expect(preview.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const restarted = await f.start(); expect(restarted.source?.id).toBe(initial.source!.id); expect(restarted.job?.id).not.toBe(job.job!.id);
  }, 15_000);

  it('enforces upload host/auth/size/signature and grants source frames only to a consenting current lease owner', async () => {
    const f = await fixture(); const peer = await f.join();
    expect((await f.app.inject({ url: f.base + '/state' })).statusCode).toBe(401);
    expect((await f.upload(clip(), peer)).statusCode).toBe(403);
    const oversized = await f.app.inject({ method: 'PUT', url: f.base + '/upload', headers: { ...f.headers(), 'content-type': 'application/octet-stream', 'content-length': String(VIDEO_LIMITS.maxUploadBytes + 1) }, payload: Buffer.from('x') });
    expect(oversized.statusCode).toBe(413);
    expect((await f.upload(Buffer.from('#EXTM3U\nhttps://example.invalid/movie.mp4'))).statusCode).toBe(422);
    await waitFor(async () => (await readdir(f.app.video.files.root)).length === 0);
    const initial = await f.prepare(clip(0.125, false)); expect(initial.source?.hasAudio).toBe(false);
    expect((await f.app.inject({ url: `${f.base}/source-preview/${initial.source!.id}.png`, headers: f.headers(peer) })).statusCode).toBe(403);
    await f.start(); expect((await f.post('/task')).statusCode).toBe(403);
    await f.post('/consent', { enabled: true }); const lease = await f.assignment();
    expect((await f.app.inject(f.sourceUrl(lease))).statusCode).toBe(401);
    expect((await f.source(lease, peer)).statusCode).toBe(409);
    await f.post('/consent', { enabled: true }, peer);
    expect((await f.source(lease, peer)).statusCode).toBe(409);
    expect((await f.source({ ...lease, attemptId: 'stale' })).statusCode).toBe(409);
    expect((await f.result(lease, Buffer.alloc(64 * 64 * 4))).statusCode).toBe(422);
    const retry = await f.assignment(); expect(retry.attemptId).not.toBe(lease.attemptId);
    await f.post('/consent', { enabled: false }); expect((await f.source(retry)).statusCode).toBe(409);
    await f.post('/cancel');
  });

  it('processes consecutive bounded windows with selected output FPS, keeps earlier previews and preserves audio', async () => {
    const f = await fixture(); await f.prepare(clip(2.625));
    const started = await f.post('/start', { settings: { ...DEFAULT_VIDEO_PROCESSING, denoise: 0, sharpen: 0, contrast: 100, saturation: 100 },
      output: { resolution: '1080p', fps: 60, quality: 'high' } });
    expect(started.statusCode, started.body).toBe(200);
    const jobId = started.json<VideoSnapshot>().job!.id;
    await f.post('/consent', { enabled: true });
    let processed = 0; let sawSecondWindow = false;
    while (true) {
      await waitFor(async () => { const job = (await f.state()).job!; return job.phase === 'processing' || job.status !== 'rendering'; });
      const snapshot = await f.state();
      if (snapshot.job!.status !== 'rendering') break;
      expect(snapshot.job!.windowEnd - snapshot.job!.windowStart).toBeLessThanOrEqual(VIDEO_LIMITS.frameWindow);
      if (snapshot.job!.windowStart >= VIDEO_LIMITS.frameWindow) {
        sawSecondWindow = true;
        const preview = await f.app.inject({ url: `${f.base}/preview/${jobId}/0.png`, headers: f.headers() });
        expect(preview.statusCode).toBe(200);
        const directory = [...f.app.video.rooms.values()][0]!.job!.directory;
        const diskFrames = (await readdir(directory)).filter((name) => /\.(rgba|ppm)$/.test(name));
        expect(diskFrames.length).toBeLessThanOrEqual(VIDEO_LIMITS.frameWindow * 2);
        expect(diskFrames).not.toContain('000000.rgba'); expect(diskFrames).not.toContain('000000.ppm');
      }
      const lease = await f.assignment();
      const input = await f.source(lease);
      expect(input.statusCode, input.body).toBe(200);
      const result = await f.result(lease, Buffer.from(processVideoFrame(input.rawPayload, lease.task)));
      expect(result.statusCode, result.body).toBe(200); processed += 1;
    }
    await waitFor(async () => (await f.state()).job!.status !== 'encoding');
    const done = (await f.state()).job!;
    expect(done.status, JSON.stringify(done)).toBe('completed'); expect(sawSecondWindow).toBe(true);
    expect(done.fps).toBe(60); expect(done.completedFrames).toBeGreaterThan(120); expect(done.totalFrames).toBe(processed);
    expect(done.frames).toHaveLength(120); expect(Object.keys(done.frameOwners)).toHaveLength(120); expect(done.frames[0]).toBeGreaterThan(0);
    expect((await f.app.inject({ url: `${f.base}/preview/${jobId}/0.png`, headers: f.headers() })).statusCode).toBe(200);
    const video = await f.app.inject({ url: `${f.base}/video/${jobId}.mp4`, headers: f.headers() });
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', 'pipe:1'],
      { input: video.rawPayload, maxBuffer: 4_000_000, windowsHide: true });
    expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBe(processed * 64 * 64 * 4);
    const audio = spawnSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-f', 'null', '-'], { input: video.rawPayload, windowsHide: true });
    expect(audio.status, audio.stderr.toString()).toBe(0);
  }, 30_000);

  it('validates output choices and losslessly transfers gzip frames with bounded decompression', async () => {
    const f = await fixture(); await f.prepare(clip(0.125, false));
    expect((await f.post('/start', { settings: DEFAULT_VIDEO_PROCESSING, output: { resolution: '1080p', fps: 61, quality: 'high' } })).statusCode).toBe(400);
    expect((await f.post('/start', { settings: DEFAULT_VIDEO_PROCESSING, output: { resolution: '4k', fps: 'source', quality: 'high' } })).statusCode).toBe(400);
    await f.start(); await f.post('/consent', { enabled: true }); const lease = await f.assignment();
    const compressed = await f.app.inject({ url: f.sourceUrl(lease), headers: { ...f.headers(), 'accept-encoding': 'gzip' } });
    expect(compressed.statusCode).toBe(200); expect(compressed.headers['content-encoding']).toBe('gzip');
    const input = gunzipSync(compressed.rawPayload); expect(input.length).toBe(64 * 64 * 4);
    const query = new URLSearchParams({ jobId: lease.task.jobId, taskId: lease.task.taskId, attemptId: lease.attemptId, computeMs: '10', engine: 'gpu', encoding: 'gzip' });
    const send = (pixels: Buffer) => f.app.inject({ method: 'PUT', url: `${f.base}/result?${query}`, headers: { ...f.headers(), 'content-type': 'application/octet-stream' }, payload: pixels });
    expect((await send(Buffer.from('invalid gzip'))).statusCode).toBe(400);
    expect((await send(gzipSync(Buffer.alloc(input.length + 1)))).statusCode).toBe(400);
    const accepted = await send(gzipSync(Buffer.from(processVideoFrame(input, lease.task))));
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await f.state()).job!.completedFrames).toBe(1);
  });

  it('limits simultaneous source and result transfers and keeps cleanup behind unfinished reads', async () => {
    const f = await fixture(); await f.prepare(); await f.start(); await f.post('/consent', { enabled: true });
    const lease = await f.assignment();
    const read = f.app.video.files.sourceFrame.bind(f.app.video.files);
    let entered = 0; let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(f.app.video.files, 'sourceFrame').mockImplementation(async (...args) => { entered += 1; await gate; return read(...args); });
    const first = f.source(lease); const second = f.source(lease);
    // inject() starts when consumed, just like the application's HTTP client.
    const pending = Promise.all([first, second]);
    await waitFor(async () => entered === 2);
    expect((await f.source(lease)).statusCode).toBe(429);
    expect((await f.result(lease, Buffer.alloc(64 * 64 * 4))).statusCode).toBe(429);
    await f.post('/cancel');
    const directory = [...f.app.video.rooms.values()][0]!.job!.directory;
    expect((await readdir(directory)).length).toBeGreaterThan(0);
    unblock(); expect((await pending).every((response) => response.statusCode === 409)).toBe(true);
    await waitFor(async () => { try { await readdir(directory); return false; } catch { return true; } });
  });

  it('extends bounded transfer leases for large source downloads and result uploads', async () => {
    const f = await fixture(); await f.prepare(); await f.start(); await f.post('/consent', { enabled: true });
    const lease = await f.assignment();
    const input = (await f.source(lease)).rawPayload;
    f.advance(45_000);
    expect((await f.post('/progress', { jobId: lease.task.jobId, taskId: lease.task.taskId, attemptId: lease.attemptId, rows: 1 })).statusCode).toBe(200);
    const prepare = f.app.video.files.prepareFrame.bind(f.app.video.files);
    vi.spyOn(f.app.video.files, 'prepareFrame').mockImplementationOnce(async (...args) => { f.advance(70_000); return prepare(...args); });
    const accepted = await f.result(lease, Buffer.from(processVideoFrame(input, lease.task)));
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('does not shorten an upload lease when a delayed final progress report arrives during the upload', async () => {
    const f = await fixture(); await f.prepare(); await f.start(); await f.post('/consent', { enabled: true });
    const lease = await f.assignment(); const input = (await f.source(lease)).rawPayload;
    const prepare = f.app.video.files.prepareFrame.bind(f.app.video.files);
    let entered!: () => void; const writing = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(f.app.video.files, 'prepareFrame').mockImplementationOnce(async (...args) => {
      entered(); await gate; return prepare(...args);
    });
    const pending = f.result(lease, Buffer.from(processVideoFrame(input, lease.task)));
    await writing;
    f.advance(5_000);
    const progress = await f.post('/progress', { jobId: lease.task.jobId, taskId: lease.task.taskId, attemptId: lease.attemptId, rows: lease.task.height });
    expect(progress.statusCode, progress.body).toBe(200);
    f.advance(60_000); unblock();
    const accepted = await pending;
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await f.state()).job!.completedFrames).toBe(1);
  });

  it('accepts a two-minute 7200-frame source while materializing only its first bounded window', async () => {
    const f = await fixture(); const prepared = await f.prepare(clip(120, false, '32x32', 60));
    expect(prepared.source!.fps).toBe(60); expect(prepared.source!.frames).toBe(7200);
    const sourceDirectory = [...f.app.video.rooms.values()][0]!.source!.directory;
    expect((await readdir(sourceDirectory)).some((name) => /\.(rgba|ppm)$/.test(name))).toBe(false);
    await f.start(); await f.post('/consent', { enabled: true }); await f.assignment();
    const room = [...f.app.video.rooms.values()][0]!;
    expect(room.job!.public.totalFrames).toBe(7200); expect(room.job!.frames).toHaveLength(24);
    expect((await readdir(room.job!.directory)).filter((name) => name.endsWith('.rgba'))).toHaveLength(24);
    expect((await f.post('/cancel')).json<VideoSnapshot>().job!.status).toBe('cancelled');
  }, 15_000);

  it('releases transient disk reservations after completed jobs while retaining their videos and previews', async () => {
    const first = await fixture();
    for (let index = 0; index < 5; index += 1) {
      const f = index === 0 ? first : await fixture(first.app);
      await f.prepare(clip(0.04, false)); await f.start(); await f.post('/consent', { enabled: true });
      const lease = await f.assignment(); const input = (await f.source(lease)).rawPayload;
      expect((await f.result(lease, Buffer.from(processVideoFrame(input, lease.task)))).statusCode).toBe(200);
      await waitFor(async () => !['rendering', 'encoding'].includes((await f.state()).job!.status));
      const snapshot = await f.state(); expect(snapshot.job!.status, JSON.stringify(snapshot.job)).toBe('completed');
      const retained = f.app.video.rooms.get(snapshot.id)!.job!;
      expect(retained.reservedBytes).toBeGreaterThanOrEqual(snapshot.job!.videoBytes);
      expect(retained.reservedBytes).toBeLessThan(1024 * 1024);
      expect((await f.app.inject({ url: `${f.base}/preview/${snapshot.job!.id}/0.png`, headers: f.headers() })).statusCode).toBe(200);
      expect((await f.app.inject({ url: `${f.base}/video/${snapshot.job!.id}.mp4`, headers: f.headers() })).statusCode).toBe(200);
    }
    expect(first.app.video.rooms.size).toBe(5);
  }, 15_000);

  it('excludes video preparation and rendering across rooms until the active pipeline finishes', async () => {
    const first = await fixture(); const second = await fixture(first.app);
    await first.prepare(); await second.prepare();
    const prepare = first.app.video.files.prepare.bind(first.app.video.files);
    let entered!: () => void; const preparing = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(first.app.video.files, 'prepare').mockImplementationOnce(async (...args) => { entered(); await gate; return prepare(...args); });
    expect((await first.upload()).statusCode).toBe(202); await preparing;
    const blockedStart = await second.post('/start', { settings: DEFAULT_VIDEO_PROCESSING });
    expect(blockedStart.statusCode).toBe(503); expect(blockedStart.json().code).toBe('PREPARATION_BUSY');
    unblock(); await waitFor(async () => (await first.state()).source?.status === 'ready');
    await second.start();
    const blockedUpload = await first.upload();
    expect(blockedUpload.statusCode).toBe(503); expect(blockedUpload.json().code).toBe('PREPARATION_BUSY');
    await second.post('/cancel');
  });

  it('keeps preparation and another render blocked during cancellation cleanup, then releases capacity', async () => {
    const first = await fixture(); const second = await fixture(first.app);
    await first.prepare(); await second.prepare(); await first.start();
    await waitFor(async () => (await first.state()).job!.phase === 'processing');
    const directory = [...first.app.video.rooms.values()][0]!.job!.directory;
    const remove = first.app.video.files.removeDirectory.bind(first.app.video.files);
    let entered!: () => void; const cleaning = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(first.app.video.files, 'removeDirectory').mockImplementation(async (path) => {
      if (path === directory) { entered(); await gate; }
      return remove(path);
    });
    expect((await first.post('/cancel')).json<VideoSnapshot>().job!.status).toBe('cancelled'); await cleaning;
    const blockedUpload = await second.upload();
    expect(blockedUpload.statusCode).toBe(503); expect(blockedUpload.json().code).toBe('PREPARATION_BUSY');
    const blockedStart = await second.post('/start', { settings: DEFAULT_VIDEO_PROCESSING });
    expect(blockedStart.statusCode).toBe(503); expect(blockedStart.json().code).toBe('RENDER_CAPACITY');
    unblock(); await waitFor(async () => { try { await readdir(directory); return false; } catch { return true; } });
    expect((await second.prepare()).source!.status).toBe('ready'); expect((await second.start()).job!.status).toBe('rendering');
  });

  it('retains the preparation slot until a cancelled source has finished cleanup', async () => {
    const first = await fixture(); const second = await fixture(first.app); await second.prepare();
    let entered!: () => void; const preparing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(first.app.video.files, 'prepare').mockImplementationOnce(async (_directory, _format, _bytes, signal) => {
      entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
      throw new Error('Unreachable');
    });
    const remove = first.app.video.files.removeDirectory.bind(first.app.video.files);
    let cleaningStarted!: () => void; const cleaning = new Promise<void>((resolve) => { cleaningStarted = resolve; });
    let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(first.app.video.files, 'removeDirectory').mockImplementationOnce(async (path) => { cleaningStarted(); await gate; return remove(path); });
    expect((await first.upload()).statusCode).toBe(202); await preparing; await first.post('/cancel'); await cleaning;
    const blocked = await second.post('/start', { settings: DEFAULT_VIDEO_PROCESSING });
    expect(blocked.statusCode).toBe(503); expect(blocked.json().code).toBe('PREPARATION_BUSY');
    expect((await second.upload()).statusCode).toBe(503);
    unblock(); await waitFor(async () => (await readdir(first.app.video.files.root)).length === 1);
    expect((await second.start()).job!.status).toBe('rendering');
  });

  it('rejects long uploads rather than silently truncating and preserves a previous ready source', async () => {
    const f = await fixture(); const initial = await f.prepare(clip(0.125, false));
    expect((await f.upload(clip(120.5, false))).statusCode).toBe(202);
    await waitFor(async () => (await f.state()).source?.status !== 'preparing');
    const restored = (await f.state()).source!;
    expect(restored.id).toBe(initial.source!.id); expect(restored.status).toBe('ready'); expect(restored.failureReason).toMatch(/120초|2분/);
    await waitFor(async () => (await readdir(f.app.video.files.root)).length === 1);
    expect((await f.start()).source!.id).toBe(initial.source!.id);
  });

  it('cancels in-flight preparation, releases its quota and accepts a later upload', async () => {
    const f = await fixture();
    const realPrepare = f.app.video.files.prepare.bind(f.app.video.files);
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(f.app.video.files, 'prepare').mockImplementationOnce(async (_directory, _format, _bytes, signal) => {
      entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
      throw new Error('Unreachable');
    });
    expect((await f.upload()).statusCode).toBe(202); await started;
    expect((await f.upload()).statusCode).toBe(409);
    const cancelled = await f.post('/cancel'); expect(cancelled.json<VideoSnapshot>().source?.status).toBe('failed');
    await waitFor(async () => (await readdir(f.app.video.files.root)).length === 0);
    vi.spyOn(f.app.video.files, 'prepare').mockImplementation(realPrepare);
    expect((await f.prepare()).source?.status).toBe('ready');
  });

  it('rejects a result after cancellation during disk write and keeps normalized source for retry', async () => {
    const f = await fixture(); await f.prepare(); await f.start(); await f.post('/consent', { enabled: true });
    const lease = await f.assignment(); const input = (await f.source(lease)).rawPayload;
    const original = f.app.video.files.prepareFrame.bind(f.app.video.files);
    let entered!: () => void; const writing = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(f.app.video.files, 'prepareFrame').mockImplementationOnce(async (...args) => { const output = await original(...args); entered(); await gate; return output; });
    const pending = f.result(lease, Buffer.from(processVideoFrame(input, lease.task))); await writing;
    expect((await f.post('/cancel')).json<VideoSnapshot>().job?.status).toBe('cancelled'); unblock();
    expect((await pending).statusCode).toBe(409);
    const restarted = await f.start(); expect(restarted.job?.completedFrames).toBe(0); expect(restarted.source?.status).toBe('ready');
  });

  it('preserves portrait aspect ratio without upscaling and returns original normalized pixels to the host preview', async () => {
    const f = await fixture(); const snapshot = await f.prepare(clip(0.125, false, '80x160'));
    expect(snapshot.source).toMatchObject({ width: 80, height: 160, fps: 24, hasAudio: false });
    const preview = await f.app.inject({ url: `${f.base}/source-preview/${snapshot.source!.id}.png`, headers: f.headers() });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.readUInt32BE(16) / preview.rawPayload.readUInt32BE(20)).toBeCloseTo(0.5, 1);
  });

  it('closes an aborted streaming upload before deleting it and frees the preparation slot', async () => {
    const f = await fixture(); await f.app.listen({ host: '127.0.0.1', port: 0 });
    const address = f.app.server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path: f.base + '/upload', method: 'PUT', headers: { ...f.headers(), 'content-type': 'application/octet-stream' } });
    request.on('error', () => {}); request.write(clip());
    await waitFor(async () => (await f.state()).source?.status === 'preparing');
    request.destroy();
    await waitFor(async () => (await f.state()).source?.status === 'failed' && (await readdir(f.app.video.files.root)).length === 0);
    expect((await f.prepare()).source?.status).toBe('ready');
  });

  it('cancels a delayed start before it can publish a new active job', async () => {
    const f = await fixture(); await f.prepare();
    const create = f.app.video.files.createDirectory.bind(f.app.video.files);
    let entered!: () => void; const entering = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(f.app.video.files, 'createDirectory').mockImplementationOnce(async (id) => { const directory = await create(id); entered(); await gate; return directory; });
    const starting = f.post('/start', { settings: DEFAULT_VIDEO_PROCESSING }); await entering;
    await f.post('/cancel'); unblock();
    expect((await starting).statusCode).toBe(409); expect((await f.state()).job).toBeNull();
    expect((await f.start()).job?.status).toBe('rendering');
  });

  it('rejects preparation reservations beyond the shared disk quota and frees them for a later real upload', async () => {
    const f = await fixture();
    vi.spyOn(f.app.video.files, 'prepare').mockImplementationOnce(async (_directory, _format, _bytes, _signal, reserve) => {
      reserve(5 * 1024 ** 3);
      throw new Error('An over-budget preparation must not proceed to decode.');
    });
    expect((await f.upload()).statusCode).toBe(202);
    await waitFor(async () => (await f.state()).source?.status === 'failed');
    expect((await f.state()).source?.failureReason).toContain('저장 공간');
    await waitFor(async () => (await readdir(f.app.video.files.root)).length === 0);
    expect((await f.prepare()).source?.status).toBe('ready');
  });

  it('aborts pending preparation before server close removes its private files', async () => {
    const f = await fixture();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let stopped = false;
    vi.spyOn(f.app.video.files, 'prepare').mockImplementationOnce(async (_directory, _format, _bytes, signal) => {
      entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(new Error('Stopped')); }, { once: true }));
      throw new Error('Unreachable');
    });
    expect((await f.upload()).statusCode).toBe(202); await started;
    await f.app.close(); servers.splice(servers.indexOf(f.app), 1);
    expect(stopped).toBe(true);
    await expect(readdir(f.app.video.files.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
