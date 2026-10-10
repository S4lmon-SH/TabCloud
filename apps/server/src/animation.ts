import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ANIMATION_LIMITS, animationSettingsSchema } from '@tabcloud/shared';
import { AnimationCoordinator, AnimationError, type AnimationAuth, type Attempt, type UploadReservation } from './animation-coordinator.js';
import { AnimationFiles } from './animation-files.js';
import type { ServerConfig } from './config.js';

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new AnimationError(400, 'INVALID_BODY', '요청 형식을 확인해 주세요.');
  return input as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new AnimationError(400, 'INVALID_BODY', '요청 형식을 확인해 주세요.');
  return value;
}
function attempt(input: Record<string, unknown>): Attempt {
  return { jobId: string(input.jobId), taskId: string(input.taskId), attemptId: string(input.attemptId) };
}

export async function registerAnimation(app: FastifyInstance, config: ServerConfig, now: () => number, allowedOrigin: (origin: string | undefined, host: string | undefined) => boolean): Promise<AnimationCoordinator> {
  const coordinator = new AnimationCoordinator(await AnimationFiles.create(), config, now);
  const auths = new WeakMap<FastifyRequest, AnimationAuth>();
  const uploads = new WeakMap<FastifyRequest, UploadReservation>();
  const creates = new Map<string, { at: number; count: number }>();
  const rates = new Map<string, { at: number; count: number }>();
  const authenticated = (request: FastifyRequest): AnimationAuth => auths.get(request)!;
  const roomId = (request: FastifyRequest): string => string((request.params as Record<string, unknown>).roomId);
  const releaseUpload = (request: FastifyRequest) => { uploads.get(request)?.finish(); uploads.delete(request); };

  await app.register(async (api) => {
    api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ANIMATION_LIMITS.maxFrameBytes }, (_request, body, done) => done(null, body));
    api.setErrorHandler((error, _request, reply) => {
      if (error instanceof AnimationError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      if (status >= 500) api.log.error(error);
      return reply.code(status).send({ code: status === 413 ? 'FRAME_TOO_LARGE' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: status < 500 ? '요청 형식을 확인해 주세요.' : '작업을 처리하지 못했어요. 다시 시도해 주세요.' });
    });
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.headers.origin && !allowedOrigin(request.headers.origin, request.headers.host)) throw new AnimationError(403, 'ORIGIN_REJECTED', '허용되지 않은 출처입니다.');
      const params = request.params as Record<string, unknown>;
      if (params.roomId !== undefined && !request.routeOptions.url?.endsWith('/join')) {
        const auth = coordinator.auth(roomId(request), request.headers.authorization);
        const at = now();
        let rate = rates.get(auth.participant.id);
        if (!rate || at - rate.at >= 1000) { rate = { at, count: 0 }; rates.set(auth.participant.id, rate); }
        if (++rate.count > config.maxMessagesPerSecond) throw new AnimationError(429, 'RATE_LIMITED', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
        auths.set(request, auth);
      }
    });
    api.addHook('onResponse', async (request) => { releaseUpload(request); });
    api.addHook('onError', async (request) => { releaseUpload(request); });

    api.post('/', async (request, reply) => {
      if (request.body !== undefined) object(request.body, []);
      for (const [address, window] of creates) if (now() - window.at >= 60_000) creates.delete(address);
      let window = creates.get(request.ip);
      if (!window) {
        if (creates.size >= 4096) throw new AnimationError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
        window = { at: now(), count: 0 }; creates.set(request.ip, window);
      }
      if (++window.count > config.roomCreatesPerMinute) throw new AnimationError(429, 'RATE_LIMITED', '잠시 후 새 작업실을 만들어 주세요.');
      return reply.code(201).send(coordinator.createRoom());
    });
    api.post('/:roomId/join', async (request) => {
      const input = object(request.body, ['inviteToken', 'hostToken', 'name']);
      return coordinator.join(roomId(request), { inviteToken: string(input.inviteToken), ...(input.hostToken === undefined ? {} : { hostToken: string(input.hostToken) }), name: string(input.name, 32).trim() || '참여자' });
    });
    api.get('/:roomId/state', async (request) => coordinator.snapshot(authenticated(request)));
    api.post('/:roomId/consent', async (request) => {
      const input = object(request.body, ['enabled']);
      if (typeof input.enabled !== 'boolean') throw new AnimationError(400, 'INVALID_BODY', 'CPU 참여 상태를 확인해 주세요.');
      return coordinator.consent(authenticated(request), input.enabled);
    });
    api.post('/:roomId/start', async (request) => {
      const input = object(request.body, ['settings']);
      const settings = animationSettingsSchema.safeParse(input.settings);
      if (!settings.success) throw new AnimationError(400, 'INVALID_SETTINGS', '영상 설정을 확인해 주세요.');
      return coordinator.start(authenticated(request), settings.data);
    });
    api.post('/:roomId/cancel', async (request) => { object(request.body, []); return coordinator.cancel(authenticated(request)); });
    api.post('/:roomId/task', async (request) => { object(request.body, []); return { assignment: coordinator.task(authenticated(request)) }; });
    api.post('/:roomId/progress', async (request) => {
      const input = object(request.body, ['jobId', 'taskId', 'attemptId', 'rows']);
      if (typeof input.rows !== 'number') throw new AnimationError(400, 'INVALID_PROGRESS', '진행 정보를 확인해 주세요.');
      coordinator.progress(authenticated(request), attempt(input), input.rows);
      return { ok: true };
    });
    api.put('/:roomId/result', {
      bodyLimit: ANIMATION_LIMITS.maxFrameBytes,
      onRequest: async (request) => {
        const query = object(request.query, ['jobId', 'taskId', 'attemptId', 'computeMs']);
        const reservation = coordinator.reserveUpload(authenticated(request), attempt(query));
        uploads.set(request, reservation);
        request.raw.once('aborted', () => releaseUpload(request));
      },
    }, async (request) => {
      const query = object(request.query, ['jobId', 'taskId', 'attemptId', 'computeMs']);
      if (!Buffer.isBuffer(request.body) || typeof query.computeMs !== 'string' || query.computeMs.length > 32 || !/^\d+(?:\.\d+)?$/.test(query.computeMs)) throw new AnimationError(400, 'INVALID_RESULT', '프레임 데이터를 확인해 주세요.');
      await coordinator.result(uploads.get(request)!, attempt(query), request.body, Number(query.computeMs));
      return { accepted: true };
    });
    api.post('/:roomId/task-error', async (request) => {
      const input = object(request.body, ['jobId', 'taskId', 'attemptId', 'message']);
      string(input.message, 500);
      coordinator.taskError(authenticated(request), attempt(input));
      return { ok: true };
    });
    api.post('/:roomId/leave', async (request) => { object(request.body, []); coordinator.leave(authenticated(request)); return { ok: true }; });
    api.get('/:roomId/preview/:jobId/:frameIndex.png', async (request, reply) => {
      const params = request.params as Record<string, string>;
      if (!/^\d{1,3}$/.test(params.frameIndex!)) throw new AnimationError(404, 'FRAME_NOT_FOUND', '프레임을 찾을 수 없어요.');
      return reply.type('image/png').send(coordinator.preview(authenticated(request), params.jobId!, Number(params.frameIndex)));
    });
    api.get('/:roomId/video/:jobId.mp4', async (request, reply) => {
      const params = request.params as Record<string, string>;
      return reply.type('video/mp4').header('Content-Disposition', 'inline; filename="tabcloud-animation.mp4"').send(coordinator.video(authenticated(request), params.jobId!));
    });
  }, { prefix: '/api/animation/rooms' });

  const timer = setInterval(() => {
    coordinator.sweep();
    for (const [key, rate] of rates) if (now() - rate.at >= 1000) rates.delete(key);
  }, config.sweepIntervalMs);
  timer.unref();
  app.addHook('preClose', async () => { clearInterval(timer); await coordinator.close(); });
  return coordinator;
}
