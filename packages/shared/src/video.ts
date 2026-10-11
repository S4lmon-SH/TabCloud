import { z } from 'zod';
import type { AnimationJobSnapshot, AnimationParticipant, AnimationRoomCreated, AnimationSnapshot } from './animation.js';

export const VIDEO_ALGORITHM = 'video-filter-v1' as const;
export const VIDEO_LIMITS = Object.freeze({ maxUploadBytes: 64 * 1024 * 1024, maxDurationSeconds: 30, maxWidth: 1280, maxHeight: 720, maxFrames: 720, fps: 24 as const, maxFrameBytes: 1280 * 720 * 4 });
export const videoProcessingSettingsSchema = z.object({
  denoise: z.number().int().min(0).max(100),
  denoiseRadius: z.number().int().min(1).max(4),
  sharpen: z.number().int().min(0).max(100),
  brightness: z.number().int().min(-50).max(50),
  contrast: z.number().int().min(50).max(150),
  saturation: z.number().int().min(0).max(200),
}).strict();
export type VideoProcessingSettings = z.infer<typeof videoProcessingSettingsSchema>;
export const DEFAULT_VIDEO_PROCESSING: Readonly<VideoProcessingSettings> = Object.freeze({ denoise: 60, denoiseRadius: 3, sharpen: 25, brightness: 0, contrast: 105, saturation: 105 });

export interface VideoFrameTask {
  jobId: string; taskId: string; frameIndex: number;
  width: number; height: number; settings: VideoProcessingSettings;
  algorithmVersion: typeof VIDEO_ALGORITHM;
}
export interface VideoAssignment { task: VideoFrameTask; attemptId: string; leaseExpiresAt: number }
export interface VideoSourceSnapshot {
  id: string; status: 'preparing' | 'ready' | 'failed';
  width: number; height: number; frames: number; fps: 24;
  durationSeconds: number; sourceBytes: number; hasAudio: boolean;
  failureReason: string | null;
}
export interface VideoParticipant extends AnimationParticipant { gpuFrames: number; cpuFrames: number }
export interface VideoJobSnapshot extends Omit<AnimationJobSnapshot, 'settings'> {
  sourceId: string; width: number; height: number; fps: 24;
  settings: VideoProcessingSettings;
}
export interface VideoSnapshot extends Omit<AnimationSnapshot, 'participants' | 'job'> {
  participants: VideoParticipant[]; source: VideoSourceSnapshot | null; job: VideoJobSnapshot | null;
}
export type VideoRoomCreated = AnimationRoomCreated;
export interface VideoJoinResult { participantId: string; participantToken: string; snapshot: VideoSnapshot }
export interface VideoTaskResult { assignment: VideoAssignment | null }
