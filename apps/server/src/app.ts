import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { LIMITS } from '@tabcloud/shared';
import { DEFAULT_CONFIG, validateConfig, type ServerConfig } from './config.js';
import { Coordinator } from './coordinator.js';
import { registerAnimation } from './animation.js';
import type { AnimationCoordinator } from './animation-coordinator.js';

export type ServerOptions = Partial<ServerConfig> & {
  staticDir?: string;
  logger?: boolean;
  now?: () => number;
};

export type TabCloudServer = FastifyInstance & { coordinator: Coordinator; animation: AnimationCoordinator };

export async function buildServer(options: ServerOptions = {}): Promise<TabCloudServer> {
  const { staticDir, logger = false, now = Date.now, ...overrides } = options;
  const config: ServerConfig = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config);
  const app = Fastify({ logger, bodyLimit: 1024, trustProxy: false, requestTimeout: 15_000 });
  const coordinator = new Coordinator(config, now);
  app.decorate('coordinator', coordinator);
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, perMessageDeflate: false });
  const rateWindows = new Map<string, { at: number; count: number }>();

  const allowedOrigin = (origin: string | undefined, host: string | undefined): boolean => {
    if (!origin || !host) return false;
    if (config.allowedOrigins.includes(origin)) return true;
    return origin === `http://${host}` || origin === `https://${host}`;
  };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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
