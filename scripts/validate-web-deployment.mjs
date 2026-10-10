const value = process.env.VITE_API_ORIGIN;
let backend;
try {
  backend = new URL(value ?? '');
} catch {
  throw new Error('Set VITE_API_ORIGIN to the deployed backend HTTPS origin before deploying the Vercel frontend.');
}
if (backend.protocol !== 'https:' || backend.origin !== value || backend.username || backend.password) {
  throw new Error('VITE_API_ORIGIN must be an exact HTTPS origin without credentials, a path, query, fragment, or trailing slash.');
}
const response = await fetch(new URL('/healthz', backend), { signal: AbortSignal.timeout(90_000) });
if (!response.ok || (await response.json()).status !== 'ok') {
  throw new Error('The backend health check failed. Deploy a working backend before publishing the frontend.');
}
console.log('Backend health check passed. Building the Vercel frontend.');
