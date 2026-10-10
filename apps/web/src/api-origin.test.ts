import { describe, expect, it } from 'vitest';
import { createApiUrls } from './api-origin';

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
