import { afterEach, describe, expect, it } from 'vitest';
import { renderAnimationFrame } from '@tabcloud/compute';
import type { AnimationAssignment, AnimationJoinResult, AnimationRoomCreated } from '@tabcloud/shared';
import { buildServer, type TabCloudServer } from './app.js';

const FRONTEND = 'https://tabcloud.vercel.app';
const servers: TabCloudServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((app) => app.close())); });

async function fixture() {
  const app = await buildServer({ allowedOrigins: [FRONTEND], sweepIntervalMs: 1_000_000 });
  servers.push(app);
  return app;
}

describe('explicit frontend CORS access', () => {
  it('allows browser create, join, authenticated state, upload and preview without cookie credentials', async () => {
    const app = await fixture();
    const origin = { origin: FRONTEND };
    const created = await app.inject({ method: 'POST', url: '/api/animation/rooms', headers: origin, payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(created.headers['access-control-allow-credentials']).toBeUndefined();
    const room = created.json<AnimationRoomCreated>();
    const base = `/api/animation/rooms/${room.roomId}`;
    const joined = await app.inject({ method: 'POST', url: `${base}/join`, headers: origin, payload: { inviteToken: room.inviteToken, hostToken: room.hostToken, name: '방장' } });
    expect(joined.statusCode).toBe(200);
    expect(joined.headers['access-control-allow-origin']).toBe(FRONTEND);
    const headers = { ...origin, authorization: `Bearer ${joined.json<AnimationJoinResult>().participantToken}` };
    const state = await app.inject({ url: `${base}/state`, headers });
    expect(state.statusCode).toBe(200);
    expect(state.headers['access-control-allow-origin']).toBe(FRONTEND);
    const unauthorized = await app.inject({ url: `${base}/state`, headers: origin });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['access-control-allow-origin']).toBe(FRONTEND);

    expect((await app.inject({ method: 'POST', url: `${base}/start`, headers, payload: { settings: { width: 64, height: 64, frames: 2, fps: 24, samples: 1, bounces: 1 } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${base}/consent`, headers, payload: { enabled: true } })).statusCode).toBe(200);
    const task = (await app.inject({ method: 'POST', url: `${base}/task`, headers, payload: {} })).json<{ assignment: AnimationAssignment }>().assignment;
    const query = new URLSearchParams({ jobId: task.task.jobId, taskId: task.task.taskId, attemptId: task.attemptId, computeMs: '10' });
    const uploaded = await app.inject({ method: 'PUT', url: `${base}/result?${query}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from(renderAnimationFrame(task.task)) });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.headers['access-control-allow-origin']).toBe(FRONTEND);
    const preview = await app.inject({ url: `${base}/preview/${task.task.jobId}/0.png`, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(preview.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(preview.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const health = await app.inject({ url: '/healthz', headers: origin });
    expect(health.statusCode).toBe(200);
    expect(health.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect((await app.inject({ method: 'POST', url: '/api/rooms', headers: origin, payload: {} })).headers['access-control-allow-origin']).toBe(FRONTEND);
  });

  it('answers JSON, authenticated read and binary upload preflights before participant authentication', async () => {
    const app = await fixture();
    for (const [method, url, headers] of [
      ['POST', '/api/animation/rooms', 'content-type'],
      ['POST', '/api/animation/rooms/room/join', 'Content-Type'],
      ['GET', '/api/animation/rooms/room/state', 'authorization'],
      ['PUT', '/api/animation/rooms/room/result', 'Authorization, CONTENT-TYPE'],
    ]) {
      const response = await app.inject({ method: 'OPTIONS', url, headers: { origin: FRONTEND, 'access-control-request-method': method, 'access-control-request-headers': headers } });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
      expect(response.headers['access-control-allow-methods']).toBe('GET, POST, PUT');
      expect(response.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers.vary).toContain('Origin');
    }
  });

  it('rejects unrelated, lookalike and opaque origins for reads, writes and OPTIONS', async () => {
    const app = await fixture();
    for (const origin of ['https://other.vercel.app', `${FRONTEND}.invalid`, `${FRONTEND}/`, 'null']) {
      for (const method of ['GET', 'POST', 'PUT', 'OPTIONS'] as const) {
        const response = await app.inject({ method, url: method === 'POST' ? '/api/animation/rooms' : '/api/animation/rooms/unknown/state', headers: { origin, 'access-control-request-method': 'PUT' }, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('ORIGIN_REJECTED');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers.vary).toContain('Origin');
      }
    }
  });

  it('only permits the required preflight methods and headers', async () => {
    const app = await fixture();
    for (const headers of [
      { 'access-control-request-method': 'DELETE' },
      { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, x-arbitrary' },
      { 'access-control-request-method': 'PUT', 'access-control-request-headers': '*' },
    ]) {
      const response = await app.inject({ method: 'OPTIONS', url: '/api/animation/rooms/room/result', headers: { origin: FRONTEND, ...headers } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('PREFLIGHT_REJECTED');
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
    }
    expect((await app.inject({ method: 'OPTIONS', url: '/api/rooms', headers: { origin: FRONTEND } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'OPTIONS', url: '/api/rooms', headers: { 'access-control-request-method': 'POST' } })).statusCode).toBe(400);
  });

  it('preserves originless API clients and same-host browser requests without granting cross-origin access', async () => {
    const app = await fixture();
    for (const headers of [{}, { host: 'local.example:3001', origin: 'http://local.example:3001' }]) {
      for (const url of ['/api/rooms', '/api/animation/rooms']) {
        const response = await app.inject({ method: 'POST', url, headers, payload: {} });
        expect(response.statusCode).toBe(201);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers.vary).toContain('Origin');
      }
    }
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('preserves existing Vary fields and never duplicates Origin', async () => {
    const app = await fixture();
    app.get('/api/vary', async (_request, reply) => reply.header('Vary', ['Accept-Encoding', 'origin']).send({ ok: true }));
    app.get('/api/vary-all', async (_request, reply) => reply.header('Vary', '*').send({ ok: true }));
    const response = await app.inject({ url: '/api/vary', headers: { origin: FRONTEND } });
    expect(response.headers.vary).toBe('Accept-Encoding, origin');
    expect((await app.inject('/api/vary-all')).headers.vary).toBe('*');
  });
});
