import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { readdir } from 'node:fs/promises';
import ffmpegStatic from 'ffmpeg-static';
import { renderAnimationFrame } from '@tabcloud/compute';
import { type AnimationAssignment, type AnimationJoinResult, type AnimationRoomCreated, type AnimationSettings, type AnimationSnapshot } from '@tabcloud/shared';
import { buildServer, type ServerOptions, type TabCloudServer } from './app.js';

const SETTINGS: AnimationSettings = { width: 64, height: 64, frames: 2, fps: 24, samples: 1, bounces: 1 };
const servers: TabCloudServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });

async function fixture(options: ServerOptions = {}) {
  let time = 1_000_000;
  const app = await buildServer({ now: () => time, sweepIntervalMs: 1_000_000, heartbeatTimeoutMs: 1_000_000, ...options });
  servers.push(app);
  const create = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/animation/rooms', payload: {} });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AnimationRoomCreated>();
  };
  const credentials = await create();
  const base = `/api/animation/rooms/${credentials.roomId}`;
  const join = async (host = false, name = '참여자', room = credentials) => {
    const response = await app.inject({ method: 'POST', url: `/api/animation/rooms/${room.roomId}/join`, payload: { inviteToken: room.inviteToken, ...(host ? { hostToken: room.hostToken } : {}), name } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AnimationJoinResult>();
  };
  const host = await join(true, '방장');
  const headers = (peer = host) => ({ authorization: `Bearer ${peer.participantToken}` });
  const post = (route: string, payload: unknown = {}, peer = host) => app.inject({ method: 'POST', url: base + route, headers: headers(peer), payload: payload as any });
  const state = async (peer = host) => (await app.inject({ method: 'GET', url: base + '/state', headers: headers(peer) })).json<AnimationSnapshot>();
  const start = async (settings = SETTINGS) => { const response = await post('/start', { settings }); expect(response.statusCode, response.body).toBe(200); return response.json<AnimationSnapshot>(); };
  const consent = async (enabled = true, peer = host) => { const response = await post('/consent', { enabled }, peer); expect(response.statusCode, response.body).toBe(200); };
  const task = async (peer = host) => { const response = await post('/task', {}, peer); expect(response.statusCode, response.body).toBe(200); return response.json<{ assignment: AnimationAssignment | null }>().assignment; };
  const resultUrl = (assignment: AnimationAssignment, computeMs = '12.123456789') => `${base}/result?${new URLSearchParams({ jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId, computeMs })}`;
  const upload = (assignment: AnimationAssignment, peer = host, pixels = Buffer.from(renderAnimationFrame(assignment.task))) => app.inject({ method: 'PUT', url: resultUrl(assignment), headers: { ...headers(peer), 'content-type': 'application/octet-stream' }, payload: pixels });
  return { app, base, credentials, host, create, join, headers, post, state, start, consent, task, upload, resultUrl, advance: (ms: number) => { time += ms; } };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for video encoding.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('animation HTTP renderer', () => {
  it('authenticates participants and assets, restricts host controls, and never starts a worker lease implicitly', async () => {
    const f = await fixture();
    const guest = await f.join();
    expect((await f.app.inject(f.base + '/state')).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: f.base + '/join', payload: { inviteToken: 'incorrect', name: '낯선 참여자' } })).statusCode).toBe(403);
    expect((await f.post('/start', { settings: SETTINGS }, guest)).statusCode).toBe(403);
    expect((await f.post('/start', { settings: { ...SETTINGS, width: 65 } })).statusCode).toBe(400);
    const initial = await f.start();
    expect(initial.participants.every((p) => !p.consented && p.activeFrame === null)).toBe(true);
    expect((await f.post('/task')).statusCode).toBe(403);
    expect((await f.post('/cancel', {}, guest)).statusCode).toBe(403);
    expect((await f.app.inject(`${f.base}/preview/${initial.job!.id}/0.png`)).statusCode).toBe(401);
    const snapshot = await f.state();
    expect(snapshot.revision).toBeGreaterThan(initial.revision);
    expect(JSON.stringify(snapshot)).not.toContain(f.credentials.hostToken);
    expect(JSON.stringify(snapshot)).not.toContain(f.credentials.inviteToken);
    expect(JSON.stringify(snapshot)).not.toContain(f.host.participantToken);
    const forbiddenOrigin = await f.app.inject({ method: 'GET', url: f.base + '/state', headers: { ...f.headers(), origin: 'https://unrelated.invalid' } });
    expect(forbiddenOrigin.statusCode).toBe(403);
  });

  it('renders on two participants, accepts each frame once, and produces an actual decodable MP4 and bounded PNG', async () => {
    const f = await fixture();
    const guest = await f.join();
    await f.start(); await f.consent(); await f.consent(true, guest);
    const first = (await f.task())!;
    const second = (await f.task(guest))!;
    expect(first.task.frameIndex).not.toBe(second.task.frameIndex);
    expect((await f.task())?.attemptId).toBe(first.attemptId);
    expect((await f.upload(first, guest)).statusCode).toBe(409);
    const duplicates = await Promise.all([f.upload(first), f.upload(first)]);
    expect(duplicates.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await f.upload(second, guest)).statusCode).toBe(200);
    await waitUntil(async () => (await f.state()).job?.status === 'completed');
    const state = await f.state();
    expect(state.job).toMatchObject({ completedFrames: 2, resultBytes: 64 * 64 * 4 * 2, frames: [0, 1], failureReason: null });
    expect(state.job!.videoBytes).toBeGreaterThan(1000);
    expect(state.participants.map((p) => p.completedFrames)).toEqual([1, 1]);
    expect(state.participants.every((p) => !p.consented && p.activeFrame === null)).toBe(true);
    const preview = await f.app.inject({ url: `${f.base}/preview/${state.job!.id}/0.png`, headers: f.headers(guest) });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const video = await f.app.inject({ url: `${f.base}/video/${state.job!.id}.mp4`, headers: f.headers(guest) });
    expect(video.statusCode).toBe(200);
    expect(video.headers['content-type']).toBe('video/mp4');
    const decoded = spawnSync(process.env.FFMPEG_PATH || ffmpegStatic!, ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'], { input: video.rawPayload, maxBuffer: 1_000_000, windowsHide: true });
    expect(decoded.status, decoded.stderr.toString()).toBe(0);
    expect(decoded.stdout.length).toBe(64 * 64 * 3 * 2);
    expect((await f.upload(first)).statusCode).toBe(409);
    const observer = await f.join();
    expect(observer.snapshot.job?.completedFrames).toBe(2);
    expect(observer.snapshot.participants.find((p) => p.id === observer.participantId)?.consented).toBe(false);
  }, 15_000);

  it('rejects malformed and invalid pixels, reassigns work after withdrawal, and revokes leaving tokens', async () => {
    const f = await fixture();
    await f.start(); await f.consent();
    const first = (await f.task())!;
    expect((await f.upload(first, f.host, Buffer.alloc(4))).statusCode).toBe(400);
    const second = (await f.task())!;
    expect(second.attemptId).not.toBe(first.attemptId);
    expect((await f.upload(second, f.host, Buffer.alloc(64 * 64 * 4))).statusCode).toBe(422);
    const third = (await f.task())!;
    await f.consent(false);
    expect((await f.upload(third)).statusCode).toBe(409);
    await f.consent();
    const fourth = (await f.task())!;
    expect(fourth.task.frameIndex).toBe(first.task.frameIndex);
    expect((await f.upload(fourth)).statusCode).toBe(200);
    expect((await f.state()).job?.completedFrames).toBe(1);
    expect((await f.post('/leave')).statusCode).toBe(200);
    expect((await f.app.inject({ url: f.base + '/state', headers: f.headers() })).statusCode).toBe(401);
  });

  it('rejects an in-flight result after cancellation and removes its files before restarting', async () => {
    const f = await fixture();
    await f.start(); await f.consent();
    const assignment = (await f.task())!;
    const original = f.app.animation.files.prepareFrame.bind(f.app.animation.files);
    let prepared!: () => void;
    const entered = new Promise<void>((resolve) => { prepared = resolve; });
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(f.app.animation.files, 'prepareFrame').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      prepared(); await gate; return result;
    });
    const response = f.upload(assignment);
    await entered;
    const cancelled = await f.post('/cancel');
    expect(cancelled.json<AnimationSnapshot>().job?.status).toBe('cancelled');
    unblock();
    expect((await response).statusCode).toBe(409);
    const replacement = await f.start();
    expect(replacement.job?.id).not.toBe(assignment.task.jobId);
    expect(replacement.job?.completedFrames).toBe(0);
    const directories = await readdir(f.app.animation.files.root);
    expect(directories).toEqual([replacement.job!.id]);
  });

  it('only renews leases on increasing progress and caps attempts even with heartbeats', async () => {
    const f = await fixture({ leaseMs: 500, animationMaxAttemptMs: 2000 });
    await f.start(); await f.consent();
    const first = (await f.task())!;
    const attempt = { jobId: first.task.jobId, taskId: first.task.taskId, attemptId: first.attemptId };
    f.advance(400);
    expect((await f.post('/progress', { ...attempt, rows: 20 })).statusCode).toBe(200);
    expect((await f.post('/progress', { ...attempt, rows: 10 })).statusCode).toBe(200);
    f.advance(400);
    expect((await f.post('/progress', { ...attempt, rows: 20 })).statusCode).toBe(200);
    f.advance(101);
    expect((await f.upload(first)).statusCode).toBe(409);
    const next = (await f.task())!;
    expect(next.attemptId).not.toBe(first.attemptId);
    expect((await f.post('/progress', { jobId: next.task.jobId, taskId: next.task.taskId, attemptId: next.attemptId, rows: 65 })).statusCode).toBe(400);
    f.advance(2001); f.app.animation.sweep();
    expect((await f.upload(next)).statusCode).toBe(409);
    expect((await f.state()).job?.retries).toBe(2);
  });

  it('allows low-budget frames beyond the fractal deadline but expires them at the animation deadline', async () => {
    const f = await fixture();
    await f.start(); await f.consent();
    const first = (await f.task())!;
    const progress = async (assignment: AnimationAssignment, rows: number) => {
      f.advance(10_000);
      return f.post('/progress', { jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId, rows });
    };
    for (let rows = 1; rows <= 13; rows += 1) expect((await progress(first, rows)).statusCode).toBe(200);
    const accepted = await f.app.inject({ method: 'PUT', url: f.resultUrl(first, '130000'), headers: { ...f.headers(), 'content-type': 'application/octet-stream' }, payload: Buffer.from(renderAnimationFrame(first.task)) });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await f.state()).job?.computeMs).toBe(130_000);

    const second = (await f.task())!;
    for (let rows = 1; rows <= 59; rows += 1) expect((await progress(second, rows)).statusCode).toBe(200);
    expect((await f.task())?.leaseExpiresAt).toBe(1_000_000 + 130_000 + 600_000);
    f.advance(10_000);
    const expired = await f.post('/progress', { jobId: second.task.jobId, taskId: second.task.taskId, attemptId: second.attemptId, rows: 60 });
    expect(expired.statusCode).toBe(409);
    f.app.animation.sweep();
    expect((await f.upload(second)).statusCode).toBe(409);
    expect((await f.state()).job?.retries).toBe(1);
    const replacement = (await f.task())!;
    expect(replacement.task.frameIndex).toBe(second.task.frameIndex);
    expect(replacement.attemptId).not.toBe(second.attemptId);
    const invalidTiming = await f.app.inject({ method: 'PUT', url: f.resultUrl(replacement, '600001'), headers: { ...f.headers(), 'content-type': 'application/octet-stream' }, payload: Buffer.from(renderAnimationFrame(replacement.task)) });
    expect(invalidTiming.statusCode).toBe(400);
  });

  it('reassigns disconnected participants and bounds concurrent renders', async () => {
    const f = await fixture({ heartbeatTimeoutMs: 500 });
    const guest = await f.join();
    await f.start(); await f.consent(true, guest);
    const old = (await f.task(guest))!;
    f.advance(501); f.app.animation.sweep();
    await f.state(); await f.consent();
    const reassigned = (await f.task())!;
    expect(reassigned.task.frameIndex).toBe(old.task.frameIndex);
    expect((await f.state()).participants.find((p) => p.id === guest.participantId)?.connected).toBe(false);
    const secondRoom = await f.create();
    const secondHost = await f.join(true, '방장2', secondRoom);
    const startOther = (room: AnimationRoomCreated, peer: AnimationJoinResult) => f.app.inject({ method: 'POST', url: `/api/animation/rooms/${room.roomId}/start`, headers: f.headers(peer), payload: { settings: SETTINGS } });
    expect((await startOther(secondRoom, secondHost)).statusCode).toBe(200);
    const thirdRoom = await f.create();
    const thirdHost = await f.join(true, '방장3', thirdRoom);
    expect((await startOther(thirdRoom, thirdHost)).statusCode).toBe(503);
    await f.post('/cancel');
    expect((await startOther(thirdRoom, thirdHost)).statusCode).toBe(200);
  });

  it('releases upload reservations when a client disconnects before sending the body', async () => {
    const f = await fixture();
    await f.start({ ...SETTINGS, frames: 1 }); await f.consent();
    const assignment = (await f.task())!;
    const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const reserve = f.app.animation.reserveUpload.bind(f.app.animation);
    for (let aborted = 0; aborted < 5; aborted += 1) {
      let acknowledge!: () => void;
      const entered = new Promise<void>((resolve) => { acknowledge = resolve; });
      vi.spyOn(f.app.animation, 'reserveUpload').mockImplementationOnce((...args) => { const reservation = reserve(...args); acknowledge(); return reservation; });
      const request = httpRequest(origin + f.resultUrl(assignment), { method: 'PUT', headers: { ...f.headers(), 'content-type': 'application/octet-stream', 'content-length': 64 * 64 * 4 } });
      request.on('error', () => { /* deliberate upload interruption */ });
      request.write(Buffer.alloc(4));
      await entered;
      const closed = new Promise<void>((resolve) => request.once('close', resolve));
      request.destroy(); await closed;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await f.upload(assignment)).statusCode).toBe(200);
    await waitUntil(async () => (await f.state()).job?.status === 'completed');
  });

  it('reports encoder failure, clears CPU consent, and cleans unusable artifacts', async () => {
    const f = await fixture();
    await f.start({ ...SETTINGS, frames: 1 }); await f.consent();
    const assignment = (await f.task())!;
    vi.spyOn(f.app.animation.files, 'encode').mockImplementationOnce(() => { throw new Error('Missing encoder executable'); });
    expect((await f.upload(assignment)).statusCode).toBe(200);
    const failed = await f.state();
    expect(failed.job?.status).toBe('failed');
    expect(failed.job?.failureReason).toContain('FFmpeg');
    expect(failed.participants.every((p) => !p.consented)).toBe(true);
    await waitUntil(async () => (await readdir(f.app.animation.files.root)).length === 0);
    expect((await f.app.inject({ url: `${f.base}/video/${assignment.task.jobId}.mp4`, headers: f.headers() })).statusCode).toBe(404);
  });

  it('terminates an active encoder before removing its job directory', async () => {
    const f = await fixture();
    await f.start({ ...SETTINGS, frames: 1 }); await f.consent();
    const assignment = (await f.task())!;
    let encoder!: ChildProcess;
    let encoderClosed = false;
    vi.spyOn(f.app.animation.files, 'encode').mockImplementationOnce(() => {
      encoder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      const completed = new Promise<void>((resolve, reject) => {
        encoder.once('error', reject);
        encoder.once('close', () => { encoderClosed = true; resolve(); });
      });
      return { process: encoder, completed };
    });
    const remove = f.app.animation.files.removeJob.bind(f.app.animation.files);
    const removed = vi.spyOn(f.app.animation.files, 'removeJob').mockImplementation(async (directory) => {
      expect(encoderClosed).toBe(true);
      await remove(directory);
    });
    expect((await f.upload(assignment)).statusCode).toBe(200);
    expect((await f.state()).job?.status).toBe('encoding');
    expect((await f.post('/cancel')).json<AnimationSnapshot>().job?.status).toBe('cancelled');
    await waitUntil(async () => (await readdir(f.app.animation.files.root)).length === 0);
    expect(encoder.killed).toBe(true);
    expect(removed).toHaveBeenCalledOnce();
  });
});
