import { z } from 'zod';

export const ANIMATION_ALGORITHM = 'raytrace-v1' as const;
export const ANIMATION_LIMITS = Object.freeze({ maxWidth: 1280, maxHeight: 720, maxFrames: 240, maxSamples: 32, maxBounces: 4, maxFrameBytes: 1280 * 720 * 4 });
const evenDimension = (max: number) => z.number().finite().int().min(64).max(max).refine((n) => n % 2 === 0, '짝수 크기를 사용해 주세요.');
export const animationSettingsSchema = z.object({
  width: evenDimension(ANIMATION_LIMITS.maxWidth),
  height: evenDimension(ANIMATION_LIMITS.maxHeight),
  frames: z.number().int().min(1).max(ANIMATION_LIMITS.maxFrames),
  fps: z.literal(24),
  samples: z.number().int().min(1).max(ANIMATION_LIMITS.maxSamples),
  bounces: z.number().int().min(1).max(ANIMATION_LIMITS.maxBounces),
}).strict();
export type AnimationSettings = z.infer<typeof animationSettingsSchema>;
export const DEFAULT_ANIMATION_SETTINGS: Readonly<AnimationSettings> = Object.freeze({ width: 1280, height: 720, frames: 120, fps: 24, samples: 8, bounces: 3 });
export const ANIMATION_PRESETS = [
  { id: 'quick', name: '미리보기', settings: { width: 320, height: 180, frames: 24, fps: 24, samples: 2, bounces: 2 } },
  { id: 'demo', name: '720p 시연', settings: { ...DEFAULT_ANIMATION_SETTINGS } },
  { id: 'heavy', name: '고화질', settings: { width: 1280, height: 720, frames: 240, fps: 24, samples: 16, bounces: 3 } },
] as const satisfies ReadonlyArray<{ id: string; name: string; settings: AnimationSettings }>;

export interface FrameTask {
  jobId: string;
  taskId: string;
  frameIndex: number;
  settings: AnimationSettings;
  algorithmVersion: typeof ANIMATION_ALGORITHM;
}
export interface AnimationAssignment { task: FrameTask; attemptId: string; leaseExpiresAt: number }
export interface AnimationParticipant {
  id: string; name: string; role: 'host' | 'participant'; connected: boolean; consented: boolean;
  completedFrames: number; computeMs: number; activeFrame: number | null;
}
export interface AnimationJobSnapshot {
  id: string;
  status: 'rendering' | 'encoding' | 'completed' | 'cancelled' | 'failed';
  settings: AnimationSettings;
  totalFrames: number; completedFrames: number;
  frames: number[];
  frameOwners: Record<string, string>;
  retries: number; startedAt: number; finishedAt: number | null;
  renderMs: number | null; encodeMs: number | null; wallMs: number | null;
  computeMs: number; resultBytes: number; videoBytes: number;
  failureReason: string | null;
}
export interface AnimationSnapshot {
  id: string; revision: number; expiresAt: number; hostConnected: boolean; selfId: string; role: 'host' | 'participant';
  participants: AnimationParticipant[]; job: AnimationJobSnapshot | null;
}
export interface AnimationRoomCreated { roomId: string; inviteToken: string; hostToken: string; expiresAt: number }
export interface AnimationJoinResult { participantId: string; participantToken: string; snapshot: AnimationSnapshot }
export interface AnimationTaskResult { assignment: AnimationAssignment | null }
