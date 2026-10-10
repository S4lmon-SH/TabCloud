import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiReadinessError, createApiUrls } from './api-origin';

describe('split frontend and API origins', () => {
  it('preserves same-origin HTTP and WebSocket endpoints by default', () => {
    const urls = createApiUrls({ frontendOrigin: 'http://localhost:5173' });
    expect(urls.api('/api/rooms')).toBe('/api/rooms');
    expect(urls.websocket('/ws')).toBe('ws://localhost:5173/ws');
  });

  it('uses secure same-origin WebSockets on a deployed HTTPS frontend', () => {
    const urls = createApiUrls({ frontendOrigin: 'https://tabcloud.vercel.app', production: true });
    expect(urls.api('/api/animation/rooms')).toBe('/api/animation/rooms');
    expect(urls.websocket('/ws')).toBe('wss://tabcloud.vercel.app/ws');
  });

  it('routes all server paths, query strings and WebSockets to the configured origin', () => {
    const urls = createApiUrls({ configuredOrigin: 'https://render.example:8443/', frontendOrigin: 'https://tabcloud.vercel.app', production: true });
    expect(urls.api('/api/animation/rooms/room/result?attemptId=one')).toBe('https://render.example:8443/api/animation/rooms/room/result?attemptId=one');
    expect(urls.api('/api/animation/rooms/room/preview/job/0.png')).toBe('https://render.example:8443/api/animation/rooms/room/preview/job/0.png');
    expect(urls.api('/api/animation/rooms/room/video/job.mp4')).toBe('https://render.example:8443/api/animation/rooms/room/video/job.mp4');
    expect(urls.websocket('/ws')).toBe('wss://render.example:8443/ws');
  });

  it('allows separate HTTP localhost origins during development', () => {
    const urls = createApiUrls({ configuredOrigin: 'http://localhost:3001', frontendOrigin: 'http://localhost:5173' });
    expect(urls.api('/api/rooms')).toBe('http://localhost:3001/api/rooms');
    expect(urls.websocket('/ws')).toBe('ws://localhost:3001/ws');
  });

  it.each(['https://api.example/path', 'https://api.example/../', 'https://api.example?', 'https://api.example#', 'https://api.example?x=1', 'https://api.example#fragment', 'https://user:secret@api.example', 'https://user@api.example', 'https://@api.example', 'https://api.example\\path', '//api.example', 'ftp://api.example', 'javascript:alert(1)', 'not a URL'])('rejects a non-origin setting: %s', (configuredOrigin) => {
    expect(() => createApiUrls({ configuredOrigin, frontendOrigin: 'https://tabcloud.vercel.app' })).toThrow();
  });

  it('rejects HTTP API origins from HTTPS pages and production builds', () => {
    expect(() => createApiUrls({ configuredOrigin: 'http://api.example', frontendOrigin: 'https://tabcloud.vercel.app' })).toThrow('HTTPS');
    expect(() => createApiUrls({ configuredOrigin: 'http://api.example', frontendOrigin: 'http://localhost:5173', production: true })).toThrow('HTTPS');
  });

  it.each(['https://other.example/path', '//other.example/path', '/\\other.example/path'])('does not let a path replace the configured host: %s', (path) => {
    const urls = createApiUrls({ configuredOrigin: 'https://api.example', frontendOrigin: 'https://tabcloud.vercel.app' });
    expect(() => urls.api(path)).toThrow();
    expect(() => urls.websocket(path)).toThrow();
  });
});

describe('external API readiness', () => {
  const frontendOrigin = 'https://tabcloud.vercel.app';
  const external = () => createApiUrls({ configuredOrigin: 'https://api.example', frontendOrigin });
  const healthy = () => Response.json({ status: 'ok' });
  afterEach(() => { vi.useRealTimers(); });

  it('skips the warmup for default and explicitly same-origin hosting', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await createApiUrls({ frontendOrigin }).ready(undefined, fetcher);
    await createApiUrls({ configuredOrigin: frontendOrigin, frontendOrigin }).ready(undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks the external health endpoint using a GET without cached data or credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(healthy());
    await external().ready(undefined, fetcher);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.example/healthz', expect.objectContaining({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
    expect(fetcher.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('allows a slow first health response beyond the normal 10-second API timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(healthy()), 55_000)));
    const pending = external().ready(undefined, fetcher);
    await vi.advanceTimersByTimeAsync(55_000);
    await expect(pending).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries transient service and network errors using only GET requests', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(healthy());
    const pending = external().ready(undefined, fetcher);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([403, 404])('fails without retrying a permanent health error (%s)', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(external().ready(undefined, fetcher)).rejects.toBeInstanceOf(ApiReadinessError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['<!doctype html>', '{"status":"starting"}'])('does not treat a non-health response as readiness: %s', async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(external().ready(undefined, fetcher)).rejects.toBeInstanceOf(ApiReadinessError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated startup errors to a total of 90 seconds', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 502 }));
    const pending = external().ready(undefined, fetcher);
    const rejected = expect(pending).rejects.toBeInstanceOf(ApiReadinessError);
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(45);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also aborts a single stalled health request at the 90-second deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })));
    const pending = external().ready(undefined, fetcher);
    const rejected = expect(pending).rejects.toBeInstanceOf(ApiReadinessError);
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an in-flight health request when its page leaves', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })));
    const pending = external().ready(controller.signal, fetcher);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels during the retry delay and never sends another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 504 }));
    const pending = external().ready(controller.signal, fetcher);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends nothing when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(external().ready(controller.signal, fetcher)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
