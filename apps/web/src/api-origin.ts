type ApiEnvironment = { configuredOrigin?: string; frontendOrigin: string; production?: boolean };
export class ApiConfigurationError extends Error {}
export class ApiReadinessError extends Error {
  constructor() { super('서버 연결이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'); }
}

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, 2000);
    if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
  });
}

/** Only the server's origin is configurable; routes always belong to TabCloud. */
export function createApiUrls({ configuredOrigin = '', frontendOrigin, production = false }: ApiEnvironment) {
  const configured = configuredOrigin.trim();
  let origin = '';
  if (configured) {
    let parsed: URL;
    try { parsed = new URL(configured); }
    catch { throw new ApiConfigurationError('렌더링 서버 주소 설정이 올바르지 않아요.'); }
    if (!/^https?:\/\/[^/?#@\s\\]+\/?$/i.test(configured) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new ApiConfigurationError('렌더링 서버 주소에는 HTTP(S) 도메인과 포트만 입력해 주세요.');
    }
    if (parsed.protocol === 'http:' && (production || new URL(frontendOrigin).protocol === 'https:')) {
      throw new ApiConfigurationError('배포된 화면에서는 HTTPS 렌더링 서버 주소를 사용해 주세요.');
    }
    origin = parsed.origin;
  }
  function api(path: string) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('올바르지 않은 API 경로입니다.');
    return `${origin}${path}`;
  }
  function websocket(path: string) {
    const url = new URL(api(path), frontendOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }
  async function ready(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
    signal?.throwIfAborted();
    if (!origin || origin === new URL(frontendOrigin).origin) return;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new ApiReadinessError()), 90_000);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      for (;;) {
        combined.throwIfAborted();
        let response: Response | undefined;
        try { response = await fetcher(api('/healthz'), { method: 'GET', cache: 'no-store', signal: combined }); }
        catch (err) { combined.throwIfAborted(); if (!(err instanceof TypeError)) throw err; }
        if (response) {
          if (response.ok) {
            const body = await response.json().catch(() => null) as { status?: string } | null;
            combined.throwIfAborted();
            if (body?.status !== 'ok') throw new ApiReadinessError();
            return;
          }
          await response.body?.cancel().catch(() => {});
          if (![502, 503, 504].includes(response.status)) throw new ApiReadinessError();
        }
        await retryDelay(combined);
      }
    } finally { clearTimeout(timer); }
  }
  return { api, websocket, ready };
}

function currentUrls() {
  return createApiUrls({ configuredOrigin: import.meta.env.VITE_API_ORIGIN, frontendOrigin: location.origin, production: import.meta.env.PROD });
}

export const apiUrl = (path: string) => currentUrls().api(path);
export const websocketUrl = (path: string) => currentUrls().websocket(path);
export const waitForApiReady = (signal?: AbortSignal) => currentUrls().ready(signal);
