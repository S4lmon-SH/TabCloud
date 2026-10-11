import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { LIMITS } from '@tabcloud/shared';
import { DEFAULT_CONFIG, validateConfig, type ServerConfig } from './config.js';
import { Coordinator } from './coordinator.js';
import { registerAnimation } from './animation.js';
import type { AnimationCoordinator } from './animation-coordinator.js';
import { registerVideo } from './video.js';
import type { VideoCoordinator } from './video-coordinator.js';

export type ServerOptions = Partial<ServerConfig> & {
  staticDir?: string;
  logger?: boolean;
  now?: () => number;
};

export type TabCloudServer = FastifyInstance & { coordinator: Coordinator; animation: AnimationCoordinator; video: VideoCoordinator };

export async function buildServer(options: ServerOptions = {}): Promise<TabCloudServer> {
  const { staticDir, logger = false, now = Date.now, ...overrides } = options;
  const config: ServerConfig = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config);
  const app = Fastify({ logger, bodyLimit: 1024, trustProxy: false, requestTimeout: 120_000 });
  const coordinator = new Coordinator(config, now);
  app.decorate('coordinator', coordinator);
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, perMessageDeflate: false });
  const rateWindows = new Map<string, { at: number; count: number }>();

  const allowedOrigin = (origin: string | undefined, host: string | undefined): boolean => {
    if (!origin || !host) return false;
    if (config.allowedOrigins.includes(origin)) return true;
    return origin === `http://${host}` || origin === `https://${host}`;
  };
  const isApi = (url: string): boolean => url.split('?')[0] === '/healthz' || url.startsWith('/api/');
  const vary = (reply: FastifyReply, ...names: string[]): void => {
    const current = reply.getHeader('Vary');
    const values = (Array.isArray(current) ? current.join(',') : String(current ?? '')).split(',').map((value) => value.trim()).filter(Boolean);
    if (values.includes('*')) return;
    for (const name of names) if (!values.some((value) => value.toLowerCase() === name.toLowerCase())) values.push(name);
    reply.header('Vary', values.join(', '));
  };

  app.addHook('onRequest', async (request, reply) => {
    if (isApi(request.url) && request.headers.origin && !allowedOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: '허용되지 않은 출처입니다.' });
    }
  });

  const preflight = async (request: FastifyRequest, reply: FastifyReply) => {
    vary(reply, 'Access-Control-Request-Method', 'Access-Control-Request-Headers');
    const method = request.headers['access-control-request-method'];
    const headers = request.headers['access-control-request-headers'];
    if (!request.headers.origin || typeof method !== 'string') {
      return reply.code(400).send({ code: 'INVALID_PREFLIGHT', message: '출처와 요청 메서드가 필요합니다.' });
    }
    if (!['GET', 'POST', 'PUT'].includes(method) || (headers !== undefined && (typeof headers !== 'string' || headers.split(',').some((header) => !['authorization', 'content-type'].includes(header.trim().toLowerCase()))))) {
      return reply.code(403).send({ code: 'PREFLIGHT_REJECTED', message: '허용되지 않은 요청입니다.' });
    }
    return reply.code(204).header('Access-Control-Allow-Methods', 'GET, POST, PUT').header('Access-Control-Allow-Headers', 'Authorization, Content-Type').send();
  };
  app.options('/api/*', preflight);
  app.options('/healthz', preflight);

  app.addHook('onSend', async (request, reply, payload) => {
    if (isApi(request.url)) {
      vary(reply, 'Origin');
      // Same-origin requests need no CORS grant. Cross-origin clients must be explicitly configured.
      if (request.headers.origin && config.allowedOrigins.includes(request.headers.origin)) reply.header('Access-Control-Allow-Origin', request.headers.origin);
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // CORP restricts no-cors embeds; authenticated CORS fetches can still create local Blob URLs.
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
    return payload;
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.post('/api/rooms', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin && !allowedOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({ code: 'ORIGIN_REJECTED', message: '허용되지 않은 출처입니다.' });
    }
    if (request.body !== undefined && (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
      return reply.code(400).send({ code: 'INVALID_BODY', message: '빈 JSON 객체만 허용합니다.' });
    }
    const at = now();
    for (const [key, value] of rateWindows) if (at - value.at >= 60_000) rateWindows.delete(key);
    let window = rateWindows.get(request.ip);
    if (!window) {
      if (rateWindows.size >= 4096) return reply.code(429).send({ code: 'RATE_LIMITED', message: '잠시 후 다시 시도하세요.' });
      window = { at, count: 0 }; rateWindows.set(request.ip, window);
    }
    if (++window.count > config.roomCreatesPerMinute) {
      return reply.code(429).header('Retry-After', '60').send({ code: 'RATE_LIMITED', message: '방 생성 요청이 너무 많습니다.' });
    }
    const room = coordinator.createRoom();
    if (!room) return reply.code(503).send({ code: 'ROOM_LIMIT', message: '서버의 방 수 한도에 도달했습니다.' });
    return reply.code(201).send(room);
  });

  app.decorate('animation', await registerAnimation(app, config, now, allowedOrigin));
  app.decorate('video', await registerVideo(app, config, now, allowedOrigin));

  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/', index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/assets/') && request.url !== '/ws') {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ code: 'NOT_FOUND' });
    });
  }

  app.server.on('upgrade', (request, socket, head) => {
    const reject = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (request.url !== '/ws') { reject('404 Not Found'); return; }
    if (!allowedOrigin(request.headers.origin, request.headers.host)) { reject('403 Forbidden'); return; }
    // Include sockets whose participant detached but whose close handshake is still pending.
    if (wss.clients.size >= config.maxConnections) { reject('503 Service Unavailable'); return; }
    wss.handleUpgrade(request, socket, head, (websocket) => coordinator.attach(websocket));
  });
  const timer = setInterval(() => coordinator.sweep(), config.sweepIntervalMs);
  timer.unref();
  app.addHook('preClose', async () => {
    clearInterval(timer);
    coordinator.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return app as unknown as TabCloudServer;
}
