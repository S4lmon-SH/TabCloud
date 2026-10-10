import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from './app.js';
import { configFromEnv } from './config.js';

async function main(): Promise<void> {
  const rootCandidate = resolve(process.cwd(), 'apps/web/dist');
  const workspaceCandidate = resolve(process.cwd(), '../web/dist');
  const staticDir = process.env.STATIC_DIR
    ? resolve(process.env.STATIC_DIR)
    : existsSync(rootCandidate) ? rootCandidate : existsSync(workspaceCandidate) ? workspaceCandidate : undefined;
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const app = await buildServer({ ...configFromEnv(), staticDir, logger: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
