import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readdir } from 'node:fs/promises';
import ffmpegStatic from 'ffmpeg-static';
import { processVideoFrame } from '@tabcloud/compute';
import { DEFAULT_VIDEO_PROCESSING, VIDEO_LIMITS, type VideoAssignment, type VideoJoinResult, type VideoRoomCreated, type VideoSnapshot } from '@tabcloud/shared';
import { buildServer, type TabCloudServer } from './app.js';

const servers: TabCloudServer[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map((app) => app.close())); });
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic!;
function clip(duration = 0.125, audio = true, size = '64x64'): Buffer {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), '-t', String(duration),
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []),
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { windowsHide: true, maxBuffer: 2_000_000 });
  expect(result.status, result.stderr.toString()).toBe(0); return result.stdout;
}
async function waitFor(predicate: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for video.'); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function fixture() {
  let now = 1_000_000;
  const app = await buildServer({ now: () => now, sweepIntervalMs: 1_000_000, heartbeatTimeoutMs: 1_000_000 }); servers.push(app);
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
  const assignment = async (peer = host) => { const response = await post('/task', {}, peer); expect(response.statusCode, response.body).toBe(200); return response.json<{ assignment: VideoAssignment | null }>().assignment!; };
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
    while ((await f.state()).job?.status === 'rendering') {
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
    expect(snapshot.job!.completedFrames).toBe(initial.source!.frames);
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

  it('rejects long uploads rather than silently truncating and preserves a previous ready source', async () => {
    const f = await fixture(); const initial = await f.prepare(clip(0.125, false));
    expect((await f.upload(clip(30.5, false))).statusCode).toBe(202);
    await waitFor(async () => (await f.state()).source?.status !== 'preparing');
    const restored = (await f.state()).source!;
    expect(restored.id).toBe(initial.source!.id); expect(restored.status).toBe('ready'); expect(restored.failureReason).toContain('30초');
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
    expect(preview.statusCode).toBe(200); expect(preview.rawPayload.readUInt32BE(16)).toBe(80); expect(preview.rawPayload.readUInt32BE(20)).toBe(160);
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
