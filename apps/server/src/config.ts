export interface ServerConfig {
  roomTtlMs: number;
  idleRoomTtlMs: number;
  heartbeatTimeoutMs: number;
  leaseMs: number;
  maxAttemptMs: number;
  maxJobMs: number;
  sweepIntervalMs: number;
  maxRetries: number;
  maxRooms: number;
  maxParticipants: number;
  maxParticipantHistory: number;
  maxJobBytes: number;
  maxTotalResultBytes: number;
  maxConnections: number;
  maxMessagesPerSecond: number;
  roomCreatesPerMinute: number;
  maxBufferedBytes: number;
  allowedOrigins: string[];
}

export const DEFAULT_CONFIG: ServerConfig = {
  roomTtlMs: 3_600_000,
  idleRoomTtlMs: 600_000,
  heartbeatTimeoutMs: 20_000,
  leaseMs: 15_000,
  maxAttemptMs: 120_000,
  maxJobMs: 600_000,
  sweepIntervalMs: 1_000,
  maxRetries: 5,
  maxRooms: 32,
  maxParticipants: 24,
  maxParticipantHistory: 64,
  maxJobBytes: 24 * 1024 * 1024,
  maxTotalResultBytes: 128 * 1024 * 1024,
  maxConnections: 256,
  maxMessagesPerSecond: 250,
  roomCreatesPerMinute: 10,
  maxBufferedBytes: 2 * 1024 * 1024,
  allowedOrigins: [],
};

export function validateConfig(config: ServerConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (key === 'allowedOrigins') continue;
    if (!Number.isSafeInteger(value) || (value as number) < (key === 'maxRetries' ? 0 : 1)) {
      throw new Error(`${key} must be a ${key === 'maxRetries' ? 'nonnegative' : 'positive'} integer`);
    }
  }
  // The shared wire schema bounds snapshots to 256 participant records.
  if (config.maxParticipants > 256 || config.maxParticipantHistory > 256 || config.maxParticipantHistory < config.maxParticipants) {
    throw new Error('Participant limits must satisfy maxParticipants <= maxParticipantHistory <= 256');
  }
  if (config.sweepIntervalMs > 2_147_483_647) throw new Error('sweepIntervalMs exceeds the Node.js timer limit');
}

/** Explicit bounds prevent accidentally disabling cleanup with NaN/negative env values. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ServerConfig> {
  const result: Partial<ServerConfig> = {};
  const keys = Object.keys(DEFAULT_CONFIG).filter((key) => key !== 'allowedOrigins') as Array<Exclude<keyof ServerConfig, 'allowedOrigins'>>;
  for (const key of keys) {
    const name = key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
    if (env[name] === undefined) continue;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < (key === 'maxRetries' ? 0 : 1)) throw new Error(`${name} must be a ${key === 'maxRetries' ? 'nonnegative' : 'positive'} integer`);
    result[key] = value;
  }
  if (env.PUBLIC_ORIGIN) {
    result.allowedOrigins = env.PUBLIC_ORIGIN.split(',').map((value) => {
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.trim()) {
        throw new Error('PUBLIC_ORIGIN must contain comma-separated HTTP(S) origins without paths');
      }
      return url.origin;
    });
  }
  validateConfig({ ...DEFAULT_CONFIG, ...result });
  return result;
}
