type ApiEnvironment = { configuredOrigin?: string; frontendOrigin: string; production?: boolean };
export class ApiConfigurationError extends Error {}

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
  return { api, websocket };
}

function currentUrls() {
  return createApiUrls({ configuredOrigin: import.meta.env.VITE_API_ORIGIN, frontendOrigin: location.origin, production: import.meta.env.PROD });
}

export const apiUrl = (path: string) => currentUrls().api(path);
export const websocketUrl = (path: string) => currentUrls().websocket(path);
