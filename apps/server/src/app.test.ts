import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { checksum, mergeTile, renderPixel, renderTile } from '@tabcloud/compute';
import { DEFAULT_SETTINGS, LIMITS, serverMessageSchema, type ClientMessage, type RenderSettings, type ServerMessage } from '@tabcloud/shared';
import { buildServer, type ServerOptions, type TabCloudServer } from './app.js';
import { configFromEnv, DEFAULT_CONFIG } from './config.js';

type Assignment = Extract<ServerMessage, { type: 'task-assigned' }>;
type Credentials = { roomId: string; inviteToken: string; hostToken: string; expiresAt: number };
const SMALL: RenderSettings = { ...DEFAULT_SETTINGS, width: 64, height: 64, tileSize: 64, maxIterations: 30 };
const servers: TabCloudServer[] = [];
const peers: Peer[] = [];

class Peer {
  messages: ServerMessage[] = [];
  private wake = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const value = serverMessageSchema.parse(JSON.parse(data.toString()));
      this.messages.push(value);
      for (const callback of this.wake) callback();
    });
  }
  send(message: ClientMessage): void { this.socket.send(JSON.stringify(message)); }
  async take<T extends ServerMessage['type']>(type: T, predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const find = () => this.messages.findIndex((message) => message.type === type && predicate(message as Extract<ServerMessage, { type: T }>));
    if (find() < 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.wake.delete(check); reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(this.messages.map((message) => message.type))}`)); }, 3000);
      const check = () => { if (find() >= 0) { clearTimeout(timer); this.wake.delete(check); resolve(); } };
      this.wake.add(check);
    });
    return this.messages.splice(find(), 1)[0] as Extract<ServerMessage, { type: T }>;
  }
  async barrier(): Promise<void> { this.send({ v: 1, type: 'heartbeat' }); await this.take('heartbeat-ack'); }
  async consent(): Promise<void> { this.send({ v: 1, type: 'consent-compute', enabled: true }); await this.barrier(); }
  async request(): Promise<Assignment> { this.send({ v: 1, type: 'request-task' }); return this.take('task-assigned'); }
  result(assignment: Assignment, pixels = Buffer.from(renderTile(assignment.task)).toString('base64')): Extract<ClientMessage, { type: 'task-result' }> {
    return { v: 1, type: 'task-result', jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId, pixels, computeMs: 12 };
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once('close', () => resolve()));
    this.socket.close();
    await closed;
  }
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture(options: ServerOptions = {}) {
  let time = 1_000_000;
  const app = await buildServer({ now: () => time, sweepIntervalMs: 1_000_000, heartbeatTimeoutMs: 1_000_000, ...options });
  servers.push(app);
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const connect = async (credentials?: Credentials, host = false, name = '테스트 참여자') => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
    const peer = new Peer(socket);
    peers.push(peer);
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    if (credentials) {
      peer.send({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, ...(host ? { hostToken: credentials.hostToken } : {}), name });
      await peer.take('room-snapshot');
    }
    return peer;
  };
  const create = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/rooms', payload: {} });
    expect(response.statusCode).toBe(201);
    return response.json<Credentials>();
  };
  const credentials = await create();
  const host = await connect(credentials, true, '방장');
  return { app, host, credentials, connect, create, origin, advance: (ms: number) => { time += ms; }, sweep: () => app.coordinator.sweep() };
}

async function start(host: Peer, settings = SMALL): Promise<string> {
  await host.barrier();
  host.messages = host.messages.filter((message) => message.type !== 'room-snapshot');
  host.send({ v: 1, type: 'start-job', settings });
  return (await host.take('room-snapshot', (message) => message.room.job?.status === 'running')).room.job!.id;
}

describe('coordinator protocol and lifecycle', () => {
  it('creates separate random credentials, serves health and security headers, and enforces creation limits', async () => {
    const { app, credentials } = await fixture({ roomCreatesPerMinute: 1 });
    expect(credentials.hostToken).not.toBe(credentials.inviteToken);
    expect(credentials.hostToken.length).toBeGreaterThanOrEqual(32);
    const health = await app.inject('/healthz');
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: {} })).statusCode).toBe(429);
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: { arbitrary: true } })).statusCode).toBe(400);
  });

  it('requires consent and host credentials for start/cancel and keeps credentials out of snapshots', async () => {
    const { host, connect, credentials } = await fixture();
    const guest = await connect(credentials);
    guest.send({ v: 1, type: 'start-job', settings: SMALL });
    expect((await guest.take('error')).code).toBe('HOST_REQUIRED');
    const jobId = await start(host);
    guest.send({ v: 1, type: 'cancel-job', jobId });
    expect((await guest.take('error')).code).toBe('HOST_REQUIRED');
    guest.send({ v: 1, type: 'request-task' });
    expect((await guest.take('error')).code).toBe('CONSENT_REQUIRED');
    expect(guest.messages.some((message) => message.type === 'task-assigned')).toBe(false);
    const snapshot = await guest.take('room-snapshot', (message) => message.room.job?.id === jobId);
    expect(JSON.stringify(snapshot)).not.toContain(credentials.hostToken);
    expect(JSON.stringify(snapshot)).not.toContain(credentials.inviteToken);
    await guest.consent();
    const assignment = await guest.request();
    expect(assignment.task.jobId).toBe(jobId);
    host.send({ v: 1, type: 'cancel-job', jobId });
    await guest.take('job-cancelled');
    const cancelled = await guest.take('room-snapshot', (message) => message.room.job?.status === 'cancelled');
    expect(cancelled.room.participants.every((entry) => !entry.consented && entry.activeTaskId === null)).toBe(true);
    guest.send(guest.result(assignment));
    expect((await guest.take('task-rejected')).reason).toBe('STALE_ATTEMPT');
  });

  it('accepts each tile once, replays completed results to late observers, and reports real bytes', async () => {
    const { host, connect, credentials } = await fixture();
    await start(host);
    await host.consent();
    const assignment = await host.request();
    const result = host.result(assignment);
    host.send(result);
    await host.take('task-accepted');
    const complete = await host.take('room-snapshot', (message) => message.room.job?.status === 'completed');
    expect(complete.room.job?.completedTasks).toBe(1);
    expect(complete.room.job?.resultBytes).toBe(64 * 64 * 4);
    expect(complete.room.job?.computeMs).toBe(12);
    host.send(result);
    expect((await host.take('task-rejected')).reason).toBe('STALE_ATTEMPT');
    const observer = await connect(credentials);
    expect((await observer.take('tile-completed')).pixels).toBe(result.pixels);
    expect(observer.messages.filter((message) => message.type === 'tile-completed')).toHaveLength(0);
  });

  it('rejects invalid sampled pixels, retries with a fresh attempt and rejects the old result', async () => {
    const { host } = await fixture();
    await start(host); await host.consent();
    const first = await host.request();
    host.send(host.result(first, Buffer.alloc(64 * 64 * 4).toString('base64')));
    expect((await host.take('task-rejected')).reason).toBe('INVALID_PIXELS');
    const next = await host.request();
    expect(next.task.taskId).toBe(first.task.taskId);
    expect(next.attemptId).not.toBe(first.attemptId);
    host.send(host.result(first));
    expect((await host.take('task-rejected')).reason).toBe('STALE_ATTEMPT');
    host.send(host.result(next));
    await host.take('task-accepted');
    const done = await host.take('room-snapshot', (message) => message.room.job?.status === 'completed');
    expect(done.room.job?.retries).toBe(1);
    expect(done.room.job?.completedTasks).toBe(1);
  });

  it('reassigns disconnected leases to a waiting consenting participant', async () => {
    const { host, connect, credentials } = await fixture();
    const guest = await connect(credentials);
    await start(host); await host.consent(); await guest.consent();
    const first = await guest.request();
    host.send({ v: 1, type: 'request-task' });
    await host.barrier();
    await guest.close();
    const reassigned = await host.take('task-assigned');
    expect(reassigned.task.taskId).toBe(first.task.taskId);
    expect(reassigned.attemptId).not.toBe(first.attemptId);
    host.send(host.result(reassigned));
    await host.take('room-snapshot', (message) => message.room.job?.status === 'completed');
  });

  it('withdrawal immediately releases work and prevents another assignment without renewed consent', async () => {
    const { host } = await fixture();
    await start(host); await host.consent();
    const first = await host.request();
    host.send({ v: 1, type: 'consent-compute', enabled: false });
    host.send({ v: 1, type: 'request-task' });
    expect((await host.take('error')).code).toBe('CONSENT_REQUIRED');
    host.send(host.result(first));
    expect((await host.take('task-rejected')).reason).toBe('STALE_ATTEMPT');
    await host.consent();
    expect((await host.request()).attemptId).not.toBe(first.attemptId);
  });

  it('only increasing row progress extends a lease; heartbeat does not extend computation', async () => {
    const { host, advance, sweep } = await fixture({ leaseMs: 100, maxAttemptMs: 250 });
    await start(host); await host.consent();
    const first = await host.request();
    advance(80);
    host.send({ v: 1, type: 'task-progress', jobId: first.task.jobId, taskId: first.task.taskId, attemptId: first.attemptId, rows: 10 });
    await host.barrier();
    advance(30); sweep();
    await host.barrier();
    expect(host.messages.some((message) => message.type === 'task-rejected')).toBe(false);
    advance(40);
    host.send({ v: 1, type: 'task-progress', jobId: first.task.jobId, taskId: first.task.taskId, attemptId: first.attemptId, rows: 10 });
    await host.barrier();
    advance(31); sweep();
    expect((await host.take('task-rejected')).reason).toBe('LEASE_EXPIRED');
    expect((await host.request()).attemptId).not.toBe(first.attemptId);
  });

  it('increasing progress cannot bypass the absolute attempt time cap', async () => {
    const { host, advance, sweep } = await fixture({ leaseMs: 100, maxAttemptMs: 180 });
    await start(host); await host.consent();
    const assignment = await host.request();
    for (const rows of [10, 20]) {
      advance(70);
      host.send({ v: 1, type: 'task-progress', jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId, rows });
      await host.barrier();
    }
    advance(41); sweep();
    expect((await host.take('task-rejected')).reason).toBe('LEASE_EXPIRED');
  });

  it('enforces retry and job runtime limits with explicit failed state', async () => {
    const { host, advance, sweep } = await fixture({ maxRetries: 1, maxJobMs: 500 });
    await start(host); await host.consent();
    for (let index = 0; index < 2; index++) {
      const assignment = await host.request();
      host.send({ v: 1, type: 'task-error', jobId: assignment.task.jobId, taskId: assignment.task.taskId, attemptId: assignment.attemptId, message: 'Worker unavailable' });
      await host.take('task-rejected');
    }
    const failed = await host.take('room-snapshot', (message) => message.room.job?.status === 'failed');
    expect(failed.room.job?.failureReason).toContain('재시도');
    await start(host);
    advance(501); sweep();
    const timeout = await host.take('room-snapshot', (message) => message.room.job?.status === 'failed');
    expect(timeout.room.job?.failureReason).toContain('시간');
  });

  it('expires rooms, closes clients, frees reserved results and refuses stale room links', async () => {
    const { app, host, connect, credentials, advance, sweep } = await fixture({ roomTtlMs: 100 });
    await start(host);
    expect(app.coordinator.resultMemoryReserved).toBeGreaterThan(0);
    advance(101); sweep();
    expect((await host.take('error')).code).toBe('ROOM_EXPIRED');
    expect(app.coordinator.roomCount).toBe(0);
    expect(app.coordinator.resultMemoryReserved).toBe(0);
    const peer = await connect();
    peer.send({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: '늦은 참여자' });
    expect((await peer.take('error')).code).toBe('ROOM_NOT_FOUND');
  });

  it('cleans idle empty rooms and heartbeat-dead connections', async () => {
    const { app, host, advance, sweep } = await fixture({ heartbeatTimeoutMs: 100, idleRoomTtlMs: 100 });
    advance(101); sweep();
    expect((await host.take('error')).code).toBe('HEARTBEAT_TIMEOUT');
    expect(app.coordinator.connectionCount).toBe(0);
    advance(101); sweep();
    expect(app.coordinator.roomCount).toBe(0);
  });

  it('limits rooms, participants, participant history and job memory', async () => {
    const { app, host, connect, credentials } = await fixture({ maxRooms: 1, maxParticipants: 2, maxParticipantHistory: 2, maxJobBytes: 100 });
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: {} })).statusCode).toBe(503);
    const guest = await connect(credentials);
    const extra = await connect();
    extra.send({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: '초과' });
    expect((await extra.take('error')).code).toBe('ROOM_FULL');
    await guest.close();
    await host.take('room-snapshot', (message) => message.room.participants.some((participant) => !participant.connected));
    extra.send({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: '대체' });
    expect((await extra.take('room-snapshot')).room.participants).toHaveLength(2);
    host.send({ v: 1, type: 'start-job', settings: SMALL });
    expect((await host.take('error')).code).toBe('MEMORY_LIMIT');
    expect(app.coordinator.resultMemoryReserved).toBe(0);
  });

  it('reserves result memory across rooms and replaces a room job without leaking its reservation', async () => {
    const { app, host, connect, create } = await fixture({ maxTotalResultBytes: 24_000 });
    const firstId = await start(host);
    const reserved = app.coordinator.resultMemoryReserved;
    expect(reserved).toBeGreaterThan(20_000);
    const otherHost = await connect(await create(), true);
    otherHost.send({ v: 1, type: 'start-job', settings: SMALL });
    expect((await otherHost.take('error')).code).toBe('MEMORY_LIMIT');
    host.send({ v: 1, type: 'cancel-job', jobId: firstId });
    await host.take('job-cancelled');
    await start(host);
    expect(app.coordinator.resultMemoryReserved).toBe(reserved);
  });

  it('rejects a valid base64 string with the wrong decoded tile size', async () => {
    const { host } = await fixture();
    await start(host); await host.consent();
    const assignment = await host.request();
    host.send(host.result(assignment, 'AAAA'));
    expect((await host.take('task-rejected')).reason).toBe('INVALID_PIXELS');
    const snapshot = await host.take('room-snapshot', (message) => message.room.job?.retries === 1);
    expect(snapshot.room.job?.completedTasks).toBe(0);
  });

  it('rejects malformed JSON, binary, invalid settings and oversized payloads without breaking health', async () => {
    const { app, host } = await fixture();
    host.socket.send('{');
    expect((await host.take('error')).code).toBe('INVALID_MESSAGE');
    host.socket.send(Buffer.from('{}'));
    expect((await host.take('error')).code).toBe('INVALID_MESSAGE');
    host.socket.send(JSON.stringify({ v: 1, type: 'start-job', settings: { ...SMALL, width: 1000000 } }));
    expect((await host.take('error')).code).toBe('INVALID_MESSAGE');
    const closed = new Promise<number>((resolve) => host.socket.once('close', (code) => resolve(code)));
    host.socket.send('x'.repeat(LIMITS.maxMessageBytes + 1));
    expect(await closed).toBe(1009);
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('rejects incorrect invite/host tokens and enforces websocket message rate limits', async () => {
    const { connect, credentials } = await fixture({ maxMessagesPerSecond: 4 });
    const guest = await connect();
    guest.send({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: 'wrong', name: '손님' });
    expect((await guest.take('error')).code).toBe('INVALID_INVITE');
    guest.send({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, hostToken: 'wrong', name: '손님' });
    expect((await guest.take('error')).code).toBe('INVALID_HOST_TOKEN');
    for (let index = 0; index < 3; index++) guest.send({ v: 1, type: 'heartbeat' });
    expect((await guest.take('error', (message) => message.code === 'RATE_LIMITED')).code).toBe('RATE_LIMITED');
  });

  it('rejects cross-origin websocket/API and missing websocket origin', async () => {
    const { app, origin } = await fixture();
    expect((await app.inject({ method: 'POST', url: '/api/rooms', headers: { origin: 'https://other.example' }, payload: {} })).statusCode).toBe(403);
    for (const requestOrigin of [undefined, 'https://other.example']) {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', requestOrigin ? { origin: requestOrigin } : {});
      const status = await new Promise<number>((resolve, reject) => {
        socket.on('unexpected-response', (_request, response) => { const code = response.statusCode ?? 0; response.resume(); socket.terminate(); resolve(code); });
        socket.on('error', () => { /* Rejected handshakes may also emit a socket error. */ });
        socket.on('open', () => reject(new Error('Unexpected accepted origin')));
      });
      expect(status).toBe(403);
    }
  });

  it('one and three participants produce the same full-pixel image as the pure reference', async () => {
    const settings = { ...SMALL, tileSize: 32 as const };
    const hashes: string[] = [];
    for (const count of [1, 3]) {
      const { host, connect, credentials } = await fixture();
      const workers = [host];
      for (let index = 1; index < count; index++) workers.push(await connect(credentials));
      for (const worker of workers) await worker.consent();
      await start(host, settings);
      const target = new Uint8ClampedArray(64 * 64 * 4);
      for (let index = 0; index < 4; index++) {
        const worker = workers[index % workers.length]!;
        const assignment = await worker.request();
        worker.send(worker.result(assignment));
        await worker.take('task-accepted');
        const acceptedTile = await host.take('tile-completed', (message) => message.task.taskId === assignment.task.taskId);
        mergeTile(target, acceptedTile.task, new Uint8ClampedArray(Buffer.from(acceptedTile.pixels, 'base64')));
      }
      await host.take('room-snapshot', (message) => message.room.job?.status === 'completed');
      hashes.push(checksum(target));
      const reference = new Uint8ClampedArray(64 * 64 * 4);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) reference.set(renderPixel(settings, x, y), (y * 64 + x) * 4);
      expect(target).toEqual(reference);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});

describe('configuration', () => {
  it('reads bounded positive numeric environment values and exact public origins', () => {
    expect(configFromEnv({ LEASE_MS: '123', PUBLIC_ORIGIN: 'https://tabcloud.example,http://localhost:5173' })).toEqual({ leaseMs: 123, allowedOrigins: ['https://tabcloud.example', 'http://localhost:5173'] });
    expect(() => configFromEnv({ LEASE_MS: '-1' })).toThrow('LEASE_MS');
    expect(() => configFromEnv({ LEASE_MS: 'NaN' })).toThrow('LEASE_MS');
    expect(() => configFromEnv({ PUBLIC_ORIGIN: 'https://tabcloud.example/path' })).toThrow('PUBLIC_ORIGIN');
    expect(configFromEnv({ MAX_RETRIES: '0' })).toEqual({ maxRetries: 0 });
    expect(DEFAULT_CONFIG.maxAttemptMs).toBe(120_000);
    expect(DEFAULT_CONFIG.animationMaxAttemptMs).toBe(600_000);
    expect(configFromEnv({ ANIMATION_MAX_ATTEMPT_MS: '300000' })).toEqual({ animationMaxAttemptMs: 300_000 });
    expect(() => configFromEnv({ ANIMATION_MAX_ATTEMPT_MS: '0' })).toThrow('ANIMATION_MAX_ATTEMPT_MS');
    expect(() => configFromEnv({ ANIMATION_MAX_ATTEMPT_MS: 'NaN' })).toThrow('ANIMATION_MAX_ATTEMPT_MS');
    expect(() => configFromEnv({ MAX_PARTICIPANT_HISTORY: '257' })).toThrow('maxParticipants <= maxParticipantHistory <= 256');
    expect(() => configFromEnv({ MAX_PARTICIPANT_HISTORY: '10' })).toThrow('maxParticipants <= maxParticipantHistory <= 256');
    expect(() => configFromEnv({ SWEEP_INTERVAL_MS: '2147483648' })).toThrow('timer limit');
  });

  it('rejects unsupported programmatic configuration before opening server resources', async () => {
    await expect(buildServer({ maxParticipants: 257, maxParticipantHistory: 257 })).rejects.toThrow('<= 256');
    await expect(buildServer({ maxJobMs: Number.NaN })).rejects.toThrow('positive integer');
    await expect(buildServer({ animationMaxAttemptMs: -1 })).rejects.toThrow('positive integer');
  });
});
