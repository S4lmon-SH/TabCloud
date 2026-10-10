import { describe, expect, it } from 'vitest';
import { ALGORITHM_VERSION, clientMessageSchema, DEFAULT_SETTINGS, LIMITS, renderSettingsSchema, serverMessageSchema, tileTaskSchema } from './index';

describe('render settings trust boundary', () => {
  it('accepts the documented defaults and non-square partial-edge dimensions', () => {
    expect(renderSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(renderSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, width: 65, height: 71, tileSize: 32 }).success).toBe(true);
  });

  it.each([
    { width: 63 }, { width: 2049 }, { height: 64.5 }, { height: Infinity },
    { tileSize: 16 }, { tileSize: 65 }, { maxIterations: 0 }, { maxIterations: 20_001 },
    { maxIterations: 2.5 }, { centerX: NaN }, { centerX: 4.01 },
    { centerY: -4.01 }, { span: 0 }, { span: 8.01 }, { span: '3.5' }, { script: 'anything' },
  ])('rejects invalid settings %j', (patch) => {
    expect(renderSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...patch }).success).toBe(false);
  });

  it('accepts the maximum documented pixel and tile budgets', () => {
    expect(renderSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, width: 2048, height: 2048, tileSize: 32 }).success).toBe(true);
  });

  it.each([8000, 19_999, 20_000])('accepts the higher iteration workload %i without enlarging image limits', (maxIterations) => {
    const settings = { ...DEFAULT_SETTINGS, width: 2048, height: 2048, maxIterations };
    expect(renderSettingsSchema.parse(settings)).toEqual(settings);
    expect(renderSettingsSchema.safeParse({ ...settings, width: 2049 }).success).toBe(false);
    expect(renderSettingsSchema.safeParse({ ...settings, height: 2049 }).success).toBe(false);
  });
});

describe('client message protocol', () => {
  const identity = { jobId: 'job-1', taskId: 'job-1:0:0', attemptId: 'attempt-1' };

  it.each([
    { type: 'join-room', roomId: 'room-1', inviteToken: 'invitation_abc', name: '브라우저 1' },
    { type: 'join-room', roomId: 'room-1', inviteToken: 'invitation_abc', hostToken: 'private_admin', name: '방장' },
    { type: 'consent-compute', enabled: true },
    { type: 'request-task' },
    { type: 'start-job', settings: DEFAULT_SETTINGS },
    { type: 'cancel-job', jobId: 'job-1' },
    { type: 'task-result', ...identity, pixels: 'CQ4b/w==', computeMs: 5.75 },
    { type: 'task-progress', ...identity, rows: 128 },
    { type: 'task-error', ...identity, message: 'Worker stopped' },
    { type: 'heartbeat' },
    { type: 'leave-room' },
  ])('accepts defined message: $type', (message) => {
    expect(clientMessageSchema.safeParse({ v: 1, ...message }).success).toBe(true);
  });

  it.each([
    { v: 2, type: 'heartbeat' },
    { v: 1, type: 'unknown' },
    { v: 1, type: 'request-task', taskId: 'chosen-by-client' },
    { v: 1, type: 'join-room', roomId: 'room-1', inviteToken: 'token', name: '   ' },
    { v: 1, type: 'join-room', roomId: 'room-1', inviteToken: 'token', name: 'x'.repeat(33) },
    { v: 1, type: 'consent-compute', enabled: 'true' },
    { v: 1, type: 'task-progress', ...identity, rows: 0 },
    { v: 1, type: 'task-progress', ...identity, rows: 129 },
    { v: 1, type: 'task-progress', ...identity, rows: 1.5 },
    { v: 1, type: 'task-error', ...identity, message: 'x'.repeat(201) },
    { v: 1, type: 'task-result', ...identity, pixels: 'CQ4b/w==', computeMs: -1 },
    { v: 1, type: 'task-result', ...identity, pixels: 'CQ4b/w==', computeMs: Infinity },
    { v: 1, type: 'task-result', ...identity, pixels: 'CQ4b/w==', computeMs: NaN },
    { v: 1, type: 'task-result', ...identity, pixels: '@@@@', computeMs: 1 },
    { v: 1, type: 'task-result', ...identity, pixels: 'AAAA\n', computeMs: 1 },
    { v: 1, type: 'task-result', ...identity, pixels: 'A===', computeMs: 1 },
    { v: 1, type: 'task-result', ...identity, pixels: 'A'.repeat(LIMITS.maxBase64Length + 4), computeMs: 1 },
  ])('rejects invalid or oversized input %#', (message) => {
    expect(clientMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe('server message runtime validation', () => {
  const task = { jobId: 'job-1', taskId: 'job-1:0:0', x: 0, y: 0, width: 128, height: 128,
    settings: DEFAULT_SETTINGS, algorithmVersion: ALGORITHM_VERSION };

  it('validates assignments and their image boundaries', () => {
    const assignment = { v: 1, type: 'task-assigned', task, attemptId: 'attempt-1', leaseUntil: 123456 };
    expect(serverMessageSchema.safeParse(assignment).success).toBe(true);
    expect(serverMessageSchema.safeParse({ ...assignment, task: { ...task, x: 1000 } }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ ...assignment, task: { ...task, algorithmVersion: 'unknown' } }).success).toBe(false);
    expect(tileTaskSchema.safeParse({ ...task, settings: { ...DEFAULT_SETTINGS, tileSize: 32 } }).success).toBe(false);
  });

  it('rejects undocumented fields instead of silently trusting them', () => {
    expect(serverMessageSchema.safeParse({ v: 1, type: 'heartbeat-ack', code: 'surprise' }).success).toBe(false);
  });
});
