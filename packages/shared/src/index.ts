import { z } from 'zod';
export * from './animation.js';

export const PROTOCOL_VERSION = 1 as const;
export const ALGORITHM_VERSION = 'mandelbrot-v1' as const;

export const LIMITS = Object.freeze({
  minDimension: 64,
  maxDimension: 2048,
  maxPixels: 4_194_304,
  tileSizes: [32, 64, 128] as const,
  minIterations: 10,
  maxIterations: 20_000,
  maxTiles: 4096,
  maxTileBytes: 65_536,
  maxBase64Length: 87_384,
  maxMessageBytes: 98_304,
  maxNameLength: 32,
});

const dimensionSchema = z.number().finite().int().min(LIMITS.minDimension).max(LIMITS.maxDimension);
const nonnegativeNumber = z.number().finite().nonnegative();
const countSchema = nonnegativeNumber.int();
const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.-]+$/);
const credentialSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const roleSchema = z.enum(['host', 'participant']);
const version = z.literal(PROTOCOL_VERSION);

export const renderSettingsSchema = z.object({
  width: dimensionSchema,
  height: dimensionSchema,
  tileSize: z.union([z.literal(32), z.literal(64), z.literal(128)]),
  maxIterations: z.number().finite().int().min(LIMITS.minIterations).max(LIMITS.maxIterations),
  centerX: z.number().finite().min(-4).max(4),
  centerY: z.number().finite().min(-4).max(4),
  span: z.number().finite().min(0.000001).max(8),
}).strict().superRefine((settings, ctx) => {
  if (settings.width * settings.height > LIMITS.maxPixels) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '전체 픽셀 수 제한을 초과했습니다.' });
  }
  if (Math.ceil(settings.width / settings.tileSize) * Math.ceil(settings.height / settings.tileSize) > LIMITS.maxTiles) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '전체 타일 수 제한을 초과했습니다.' });
  }
});

export type RenderSettings = z.infer<typeof renderSettingsSchema>;

export const DEFAULT_SETTINGS: Readonly<RenderSettings> = Object.freeze({
  width: 1024,
  height: 1024,
  tileSize: 128,
  maxIterations: 500,
  centerX: -0.5,
  centerY: 0,
  span: 3.5,
});

export const tileTaskSchema = z.object({
  jobId: identifierSchema,
  taskId: identifierSchema,
  x: countSchema,
  y: countSchema,
  width: z.number().finite().int().min(1).max(128),
  height: z.number().finite().int().min(1).max(128),
  settings: renderSettingsSchema,
  algorithmVersion: z.literal(ALGORITHM_VERSION),
}).strict().superRefine((task, ctx) => {
  if (task.x + task.width > task.settings.width || task.y + task.height > task.settings.height) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '타일이 이미지 경계를 벗어났습니다.' });
  }
  if (task.width > task.settings.tileSize || task.height > task.settings.tileSize) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '타일 크기가 설정을 초과했습니다.' });
  }
});

export type TileTask = z.infer<typeof tileTaskSchema>;

// Bounded, padded standard base64. Decoded byte length is checked against the lease by the server.
export const pixelsSchema = z.string().min(4).max(LIMITS.maxBase64Length)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const attemptFields = {
  jobId: identifierSchema,
  taskId: identifierSchema,
  attemptId: identifierSchema,
};

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ v: version, type: z.literal('join-room'), roomId: identifierSchema,
    inviteToken: credentialSchema, hostToken: credentialSchema.optional(),
    name: z.string().trim().min(1).max(LIMITS.maxNameLength) }).strict(),
  z.object({ v: version, type: z.literal('consent-compute'), enabled: z.boolean() }).strict(),
  z.object({ v: version, type: z.literal('request-task') }).strict(),
  z.object({ v: version, type: z.literal('start-job'), settings: renderSettingsSchema }).strict(),
  z.object({ v: version, type: z.literal('cancel-job'), jobId: identifierSchema }).strict(),
  z.object({ v: version, type: z.literal('task-result'), ...attemptFields,
    pixels: pixelsSchema, computeMs: nonnegativeNumber }).strict(),
  z.object({ v: version, type: z.literal('task-progress'), ...attemptFields,
    rows: z.number().finite().int().min(1).max(128) }).strict(),
  z.object({ v: version, type: z.literal('task-error'), ...attemptFields,
    message: z.string().min(1).max(200) }).strict(),
  z.object({ v: version, type: z.literal('heartbeat') }).strict(),
  z.object({ v: version, type: z.literal('leave-room') }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const participantSnapshotSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(LIMITS.maxNameLength),
  role: roleSchema,
  connected: z.boolean(),
  consented: z.boolean(),
  completedTasks: countSchema,
  computeMs: nonnegativeNumber,
  activeTaskId: identifierSchema.nullable(),
}).strict();

export type ParticipantSnapshot = z.infer<typeof participantSnapshotSchema>;

export const jobSnapshotSchema = z.object({
  id: identifierSchema,
  status: z.enum(['created', 'running', 'completed', 'cancelled', 'failed']),
  settings: renderSettingsSchema,
  totalTasks: countSchema.max(LIMITS.maxTiles),
  completedTasks: countSchema.max(LIMITS.maxTiles),
  retries: countSchema,
  startedAt: nonnegativeNumber.nullable(),
  finishedAt: nonnegativeNumber.nullable(),
  wallMs: nonnegativeNumber.nullable(),
  computeMs: nonnegativeNumber,
  validationMs: nonnegativeNumber,
  roundTripMs: nonnegativeNumber,
  resultBytes: countSchema,
  failureReason: z.string().max(500).nullable(),
}).strict();

export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;

export const roomSnapshotSchema = z.object({
  id: identifierSchema,
  expiresAt: nonnegativeNumber,
  hostConnected: z.boolean(),
  participants: z.array(participantSnapshotSchema).max(256),
  job: jobSnapshotSchema.nullable(),
  events: z.array(z.object({ at: nonnegativeNumber, message: z.string().max(500) }).strict()).max(256),
}).strict();

export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ v: version, type: z.literal('room-snapshot'), room: roomSnapshotSchema,
    selfId: identifierSchema, role: roleSchema }).strict(),
  z.object({ v: version, type: z.literal('task-assigned'), task: tileTaskSchema,
    attemptId: identifierSchema, leaseUntil: nonnegativeNumber }).strict(),
  z.object({ v: version, type: z.literal('task-accepted'), ...attemptFields }).strict(),
  z.object({ v: version, type: z.literal('task-rejected'), ...attemptFields,
    reason: z.string().max(500) }).strict(),
  z.object({ v: version, type: z.literal('tile-completed'), task: tileTaskSchema,
    pixels: pixelsSchema, participantId: identifierSchema }).strict(),
  z.object({ v: version, type: z.literal('job-cancelled'), jobId: identifierSchema }).strict(),
  z.object({ v: version, type: z.literal('error'), code: z.string().min(1).max(128),
    message: z.string().max(500) }).strict(),
  z.object({ v: version, type: z.literal('heartbeat-ack') }).strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
