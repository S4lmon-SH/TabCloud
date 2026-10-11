import { z } from 'zod';
import type { AnimationJobSnapshot, AnimationParticipant, AnimationRoomCreated, AnimationSnapshot } from './animation.js';

export const VIDEO_ALGORITHM = 'video-filter-v1' as const;
export const VIDEO_LIMITS = Object.freeze({ maxUploadBytes: 256 * 1024 * 1024, maxDurationSeconds: 120,
  maxWidth: 1920, maxHeight: 1920, maxLongEdge: 1920, maxShortEdge: 1080, maxFrames: 7200,
  maxFps: 60, frameWindow: 24, maxFrameBytes: 1920 * 1080 * 4 });
export const VIDEO_INPUT_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'flv', '3gp'] as const;
export const videoOutputSettingsSchema = z.object({
  resolution: z.enum(['720p', '1080p']),
  fps: z.union([z.literal('source'), z.literal(24), z.literal(30), z.literal(60)]),
  quality: z.enum(['high', 'balanced', 'compact']),
}).strict();
export type VideoOutputSettings = z.infer<typeof videoOutputSettingsSchema>;
export const DEFAULT_VIDEO_OUTPUT: Readonly<VideoOutputSettings> = Object.freeze({ resolution: '1080p', fps: 'source', quality: 'high' });
export function isSupportedVideoDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && Math.max(width, height) <= VIDEO_LIMITS.maxLongEdge && Math.min(width, height) <= VIDEO_LIMITS.maxShortEdge;
}
/** Source dimensions already include rotation and square-pixel display aspect. Never upscale. */
export function resolveVideoOutput(source: { width: number; height: number; fps: number }, output: VideoOutputSettings) {
  if (![source.width, source.height, source.fps].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid video source metadata.');
  const longEdge = output.resolution === '1080p' ? 1920 : 1280;
  const shortEdge = output.resolution === '1080p' ? 1080 : 720;
  const scale = Math.min(1, longEdge / Math.max(source.width, source.height), shortEdge / Math.min(source.width, source.height));
  return { width: Math.max(2, Math.floor(source.width * scale / 2) * 2), height: Math.max(2, Math.floor(source.height * scale / 2) * 2),
    fps: output.fps === 'source' ? Math.min(VIDEO_LIMITS.maxFps, Math.max(1, source.fps)) : output.fps };
}
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
  width: number; height: number; frames: number; fps: number;
  durationSeconds: number; sourceBytes: number; hasAudio: boolean;
  failureReason: string | null;
  originalWidth?: number; originalHeight?: number; originalFps?: number;
  container?: string; videoCodec?: string; frameCountExact?: boolean;
}
export interface VideoParticipant extends AnimationParticipant { gpuFrames: number; cpuFrames: number }
export interface VideoJobSnapshot extends Omit<AnimationJobSnapshot, 'settings'> {
  sourceId: string; width: number; height: number; fps: number;
  settings: VideoProcessingSettings;
  output: VideoOutputSettings;
  phase: 'decoding' | 'processing' | 'encoding-segment' | 'finalizing';
  windowStart: number; windowEnd: number; frameCountExact: boolean;
}
export interface VideoSnapshot extends Omit<AnimationSnapshot, 'participants' | 'job'> {
  participants: VideoParticipant[]; source: VideoSourceSnapshot | null; job: VideoJobSnapshot | null;
}
export type VideoRoomCreated = AnimationRoomCreated;
export interface VideoJoinResult { participantId: string; participantToken: string; snapshot: VideoSnapshot }
export interface VideoTaskResult { assignment: VideoAssignment | null }
