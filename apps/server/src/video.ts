import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { VIDEO_LIMITS, DEFAULT_VIDEO_OUTPUT, videoProcessingSettingsSchema, videoOutputSettingsSchema } from '@tabcloud/shared';
import { VideoCoordinator, VideoError, type VideoAuth, type Attempt, type UploadReservation, type SourceUpload } from './video-coordinator.js';
import { VideoFiles, VideoFileError } from './video-files.js';
import type { ServerConfig } from './config.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new VideoError(400, 'INVALID_BODY', '요청 형식을 확인해 주세요.');
  return input as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new VideoError(400, 'INVALID_BODY', '요청 형식을 확인해 주세요.');
  return value;
}
function attempt(input: Record<string, unknown>): Attempt {
  return { jobId: string(input.jobId), taskId: string(input.taskId), attemptId: string(input.attemptId) };
}

export async function registerVideo(app: FastifyInstance, config: ServerConfig, now: () => number, allowedOrigin: (origin: string | undefined, host: string | undefined) => boolean): Promise<VideoCoordinator> {
  const coordinator = new VideoCoordinator(await VideoFiles.create(), config, now);
  const auths = new WeakMap<FastifyRequest, VideoAuth>();
  const uploads = new WeakMap<FastifyRequest, UploadReservation>();
  const sources = new WeakMap<FastifyRequest, SourceUpload>();
  const reads = new WeakMap<FastifyRequest, { finish: () => void }>();
  const transfers = new WeakMap<FastifyRequest, { releaseRequested: boolean }>();
  const creates = new Map<string, { at: number; count: number }>();
  const rates = new Map<string, { at: number; count: number }>();
  const authenticated = (request: FastifyRequest): VideoAuth => auths.get(request)!;
  const roomId = (request: FastifyRequest): string => string((request.params as Record<string, unknown>).roomId);
  const releaseUpload = (request: FastifyRequest) => {
    const transfer = transfers.get(request);
    if (transfer) { transfer.releaseRequested = true; return; }
    uploads.get(request)?.finish(); uploads.delete(request); reads.get(request)?.finish(); reads.delete(request);
  };
  const transfer = async <T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> => {
    const active = { releaseRequested: false }; transfers.set(request, active);
    try { return await work(); }
    finally { transfers.delete(request); if (active.releaseRequested) releaseUpload(request); }
  };

  await app.register(async (api) => {
    // Source uploads remain streamed; individual processed frames are collected only after strict bounds below.
    api.addContentTypeParser('application/octet-stream', (_request, body, done) => done(null, body));
    api.setErrorHandler((error, _request, reply) => {
      if (error instanceof VideoError || error instanceof VideoFileError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      if (status >= 500) api.log.error(error);
      return reply.code(status).send({ code: status === 413 ? 'FRAME_TOO_LARGE' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: status < 500 ? '요청 형식을 확인해 주세요.' : '작업을 처리하지 못했어요. 다시 시도해 주세요.' });
    });
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.headers.origin && !allowedOrigin(request.headers.origin, request.headers.host)) throw new VideoError(403, 'ORIGIN_REJECTED', '허용되지 않은 출처입니다.');
      const params = request.params as Record<string, unknown>;
      if (params.roomId !== undefined && !request.routeOptions.url?.endsWith('/join')) {
        const auth = coordinator.auth(roomId(request), request.headers.authorization);
        const at = now();
        let rate = rates.get(auth.participant.id);
        if (!rate || at - rate.at >= 1000) { rate = { at, count: 0 }; rates.set(auth.participant.id, rate); }
        if (++rate.count > config.maxMessagesPerSecond) throw new VideoError(429, 'RATE_LIMITED', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
        auths.set(request, auth);
      }
    });
    api.addHook('onResponse', async (request) => { releaseUpload(request); sources.get(request)?.finish(); sources.delete(request); });
    api.addHook('onError', async (request, _reply, error) => { releaseUpload(request); const source = sources.get(request); if (source) coordinator.abortUpload(source, error); sources.delete(request); });

    api.post('/', async (request, reply) => {
      if (request.body !== undefined) object(request.body, []);
      for (const [address, window] of creates) if (now() - window.at >= 60_000) creates.delete(address);
      let window = creates.get(request.ip);
      if (!window) {
        if (creates.size >= 4096) throw new VideoError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
        window = { at: now(), count: 0 }; creates.set(request.ip, window);
      }
      if (++window.count > config.roomCreatesPerMinute) throw new VideoError(429, 'RATE_LIMITED', '잠시 후 새 작업실을 만들어 주세요.');
      return reply.code(201).send(coordinator.createRoom());
    });
    api.post('/:roomId/join', async (request) => {
      const input = object(request.body, ['inviteToken', 'hostToken', 'name']);
      return coordinator.join(roomId(request), { inviteToken: string(input.inviteToken), ...(input.hostToken === undefined ? {} : { hostToken: string(input.hostToken) }), name: string(input.name, 32).trim() || '참여자' });
    });
    api.get('/:roomId/state', async (request) => coordinator.snapshot(authenticated(request)));
    api.put('/:roomId/upload', {
      bodyLimit: VIDEO_LIMITS.maxUploadBytes,
      onRequest: async (request) => {
        if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream') throw new VideoError(415, 'INVALID_CONTENT_TYPE', '동영상 파일을 바이너리로 업로드해 주세요.');
        const length = request.headers['content-length'];
        const reservation = await coordinator.beginUpload(authenticated(request), length === undefined ? undefined : Number(length));
        sources.set(request, reservation);
        request.raw.once('aborted', () => coordinator.abortUpload(reservation, new Error('Upload disconnected.')));
      },
    }, async (request, reply) => {
      if (!(request.body instanceof Readable)) throw new VideoError(400, 'INVALID_BODY', '동영상 파일을 확인해 주세요.');
      return reply.code(202).send(await coordinator.receiveUpload(sources.get(request)!, request.body));
    });
    api.post('/:roomId/consent', async (request) => {
      const input = object(request.body, ['enabled']);
      if (typeof input.enabled !== 'boolean') throw new VideoError(400, 'INVALID_BODY', '기기 참여 상태를 확인해 주세요.');
      return coordinator.consent(authenticated(request), input.enabled);
    });
    api.post('/:roomId/start', async (request) => {
      const input = object(request.body, ['settings', 'output']);
      const settings = videoProcessingSettingsSchema.safeParse(input.settings);
      const output = videoOutputSettingsSchema.safeParse(input.output ?? DEFAULT_VIDEO_OUTPUT);
      if (!settings.success || !output.success) throw new VideoError(400, 'INVALID_SETTINGS', '영상 설정을 확인해 주세요.');
      return coordinator.start(authenticated(request), settings.data, output.data);
    });
    api.post('/:roomId/cancel', async (request) => { object(request.body, []); return coordinator.cancel(authenticated(request)); });
    api.post('/:roomId/task', async (request) => { object(request.body, []); return { assignment: coordinator.task(authenticated(request)) }; });
    api.post('/:roomId/progress', async (request) => {
      const input = object(request.body, ['jobId', 'taskId', 'attemptId', 'rows']);
      if (typeof input.rows !== 'number') throw new VideoError(400, 'INVALID_PROGRESS', '진행 정보를 확인해 주세요.');
      coordinator.progress(authenticated(request), attempt(input), input.rows);
      return { ok: true };
    });
    api.put('/:roomId/result', {
      bodyLimit: VIDEO_LIMITS.maxFrameBytes + 65_536,
      onRequest: async (request) => {
        const query = object(request.query, ['jobId', 'taskId', 'attemptId', 'computeMs', 'engine', 'encoding']);
        if (query.encoding !== undefined && query.encoding !== 'raw' && query.encoding !== 'gzip') throw new VideoError(400, 'INVALID_ENCODING', '프레임 전송 형식을 확인해 주세요.');
        const length = request.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > VIDEO_LIMITS.maxFrameBytes + 65_536)) throw new VideoError(413, 'FRAME_TOO_LARGE', '프레임이 너무 커요.');
        const reservation = coordinator.reserveUpload(authenticated(request), attempt(query));
        uploads.set(request, reservation);
        request.raw.once('aborted', () => releaseUpload(request));
      },
    }, async (request) => transfer(request, async () => {
      const query = object(request.query, ['jobId', 'taskId', 'attemptId', 'computeMs', 'engine', 'encoding']);
      if (!(request.body instanceof Readable) || typeof query.computeMs !== 'string' || query.computeMs.length > 32 || !/^\d+(?:\.\d+)?$/.test(query.computeMs)
        || query.engine !== undefined && !['cpu', 'gpu', 'mixed'].includes(String(query.engine))) throw new VideoError(400, 'INVALID_RESULT', '프레임 데이터를 확인해 주세요.');
      const reservation = uploads.get(request)!;
      const expectedBytes = reservation.job.public.width * reservation.job.public.height * 4;
      const maximumBytes = expectedBytes + (query.encoding === 'gzip' ? 65_536 : 0);
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request.body) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > maximumBytes) throw new VideoError(413, 'FRAME_TOO_LARGE', '프레임이 너무 커요.');
        chunks.push(buffer);
      }
      let pixels = Buffer.concat(chunks, bytes); chunks.length = 0;
      if (query.encoding === 'gzip') {
        try { pixels = await decompress(pixels, { maxOutputLength: expectedBytes }); }
        catch { throw new VideoError(400, 'INVALID_COMPRESSED_FRAME', '압축 프레임의 크기와 형식을 확인해 주세요.'); }
      }
      await coordinator.result(reservation, attempt(query), pixels, Number(query.computeMs), (query.engine ?? 'cpu') as 'cpu' | 'gpu' | 'mixed');
      return { accepted: true };
    }));
    api.post('/:roomId/task-error', async (request) => {
      const input = object(request.body, ['jobId', 'taskId', 'attemptId', 'message']);
      string(input.message, 500);
      coordinator.taskError(authenticated(request), attempt(input));
      return { ok: true };
    });
    api.post('/:roomId/leave', async (request) => { object(request.body, []); coordinator.leave(authenticated(request)); return { ok: true }; });
    api.get('/:roomId/source/:jobId/:frameIndex.rgba', async (request, reply) => transfer(request, async () => {
      const params = request.params as Record<string, string>; const query = object(request.query, ['taskId', 'attemptId']);
      if (!/^\d{1,4}$/.test(params.frameIndex!)) throw new VideoError(404, 'FRAME_NOT_FOUND', '프레임을 찾을 수 없어요.');
      const assignment = { jobId: params.jobId!, taskId: string(query.taskId), attemptId: string(query.attemptId) };
      const reservation = coordinator.reserveSourceRead(authenticated(request), assignment);
      reads.set(request, reservation); request.raw.once('aborted', () => releaseUpload(request));
      const pixels = await coordinator.sourceFrame(authenticated(request), assignment, Number(params.frameIndex));
      if (/\bgzip\b/i.test(request.headers['accept-encoding'] ?? '')) {
        return reply.type('application/octet-stream').header('Content-Encoding', 'gzip').header('Vary', 'Accept-Encoding').send(await compress(pixels, { level: 1 }));
      }
      return reply.type('application/octet-stream').header('Vary', 'Accept-Encoding').send(pixels);
    }));
    api.get('/:roomId/source-preview/:sourceId.png', async (request, reply) => {
      const params = request.params as Record<string, string>;
      return reply.type('image/png').send(await coordinator.sourcePreview(authenticated(request), params.sourceId!));
    });
    api.get('/:roomId/preview/:jobId/:frameIndex.png', async (request, reply) => {
      const params = request.params as Record<string, string>;
      if (!/^\d{1,4}$/.test(params.frameIndex!)) throw new VideoError(404, 'FRAME_NOT_FOUND', '프레임을 찾을 수 없어요.');
      return reply.type('image/png').send(await coordinator.preview(authenticated(request), params.jobId!, Number(params.frameIndex)));
    });
    api.get('/:roomId/video/:jobId.mp4', async (request, reply) => {
      const params = request.params as Record<string, string>;
      return reply.type('video/mp4').header('Content-Disposition', 'inline; filename="tabcloud-video.mp4"').send(coordinator.video(authenticated(request), params.jobId!));
    });
  }, { prefix: '/api/video/rooms' });

  const timer = setInterval(() => {
    coordinator.sweep();
    for (const [key, rate] of rates) if (now() - rate.at >= 1000) rates.delete(key);
  }, config.sweepIntervalMs);
  timer.unref();
  app.addHook('preClose', async () => { clearInterval(timer); await coordinator.close(); });
  return coordinator;
}
