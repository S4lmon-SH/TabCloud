import { randomBytes, randomInt } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  ANIMATION_ALGORITHM, animationSettingsSchema,
  type AnimationAssignment, type AnimationJobSnapshot, type AnimationJoinResult,
  type AnimationParticipant, type AnimationRoomCreated, type AnimationSettings, type AnimationSnapshot,
} from '@tabcloud/shared';
import { renderAnimationPixel } from '@tabcloud/compute';
import type { ServerConfig } from './config.js';
import { AnimationFiles } from './animation-files.js';

const id = () => randomBytes(16).toString('base64url');
const token = () => randomBytes(32).toString('base64url');
const MAX_ALLOCATIONS = 2;
const MAX_DISK_BYTES = 1_500 * 1024 * 1024;
const JOB_DEADLINE_MS = 30 * 60 * 1000;

export class AnimationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new AnimationError(status, code, message); }

interface Participant extends AnimationParticipant {
  token: string; lastSeen: number; revoked: boolean; activeAttempt: string | null;
}
interface Frame {
  index: number; owner: string | null; attemptId: string | null; startedAt: number; expiresAt: number;
  rows: number; attempts: number; done: boolean; uploading: boolean;
}
interface Job {
  public: AnimationJobSnapshot; directory: string; frames: Frame[]; reservedBytes: number;
  uploads: Set<Promise<void>>; encoder: ChildProcess | null; encoding: Promise<void> | null;
  cleanup: Promise<void> | null;
}
interface Room {
  id: string; inviteToken: string; hostToken: string; expiresAt: number; lastActiveAt: number;
  participants: Map<string, Participant>; job: Job | null; starting: boolean;
  revision: number;
}
export interface AnimationAuth { room: Room; participant: Participant }
export interface UploadReservation { auth: AnimationAuth; job: Job; frame: Frame; finish: () => void }
export interface Attempt { jobId: string; taskId: string; attemptId: string }

export class AnimationCoordinator {
  readonly rooms = new Map<string, Room>();
  private readonly allocations = new Set<Job>();
  private readonly cleanups = new Set<Promise<void>>();
  private uploading = 0;
  private closed = false;

  constructor(readonly files: AnimationFiles, private readonly config: ServerConfig, private readonly now: () => number) {}

  createRoom(): AnimationRoomCreated {
    this.sweep();
    if (this.closed || this.rooms.size >= this.config.maxRooms) fail(503, 'ROOM_LIMIT', '잠시 후 새 작업실을 만들어 주세요.');
    const room: Room = { id: id(), inviteToken: token(), hostToken: token(), expiresAt: this.now() + this.config.roomTtlMs,
      lastActiveAt: this.now(), participants: new Map(), job: null, starting: false, revision: 0 };
    this.rooms.set(room.id, room);
    return { roomId: room.id, inviteToken: room.inviteToken, hostToken: room.hostToken, expiresAt: room.expiresAt };
  }

  private room(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room || room.expiresAt <= this.now()) fail(404, 'ROOM_NOT_FOUND', '작업실이 없거나 만료됐어요.');
    return room;
  }

  join(roomId: string, input: { inviteToken: string; hostToken?: string; name: string }): AnimationJoinResult {
    this.sweep();
    const room = this.room(roomId);
    if (room.inviteToken !== input.inviteToken) fail(403, 'INVALID_INVITE', '초대 링크를 확인해 주세요.');
    if (input.hostToken !== undefined && input.hostToken !== room.hostToken) fail(403, 'INVALID_HOST', '방장 정보가 올바르지 않아요.');
    const connected = [...room.participants.values()].filter((p) => p.connected);
    if (connected.length >= this.config.maxParticipants || this.connectedCount() >= this.config.maxConnections) fail(503, 'PARTICIPANT_LIMIT', '참여 인원이 가득 찼어요.');
    if (room.participants.size >= this.config.maxParticipantHistory) {
      const old = [...room.participants.values()].find((p) => !p.connected && p.role !== 'host');
      if (old) room.participants.delete(old.id);
      else fail(503, 'PARTICIPANT_LIMIT', '참여 기록 한도에 도달했어요.');
    }
    const participant: Participant = { id: id(), token: token(), name: input.name, role: input.hostToken ? 'host' : 'participant', connected: true,
      consented: false, completedFrames: 0, computeMs: 0, activeFrame: null, activeAttempt: null, lastSeen: this.now(), revoked: false };
    room.participants.set(participant.id, participant);
    room.lastActiveAt = this.now();
    return { participantId: participant.id, participantToken: participant.token, snapshot: this.snapshot({ room, participant }) };
  }

  auth(roomId: string, authorization: string | undefined): AnimationAuth {
    const room = this.room(roomId);
    const credential = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const participant = credential && [...room.participants.values()].find((p) => p.token === credential && !p.revoked);
    if (!participant) fail(401, 'AUTH_REQUIRED', '초대 링크로 다시 참여해 주세요.');
    if (!participant.connected) {
      if ([...room.participants.values()].filter((p) => p.connected).length >= this.config.maxParticipants || this.connectedCount() >= this.config.maxConnections) fail(503, 'PARTICIPANT_LIMIT', '참여 인원이 가득 찼어요.');
      participant.connected = true;
      participant.consented = false;
    }
    participant.lastSeen = this.now();
    room.lastActiveAt = this.now();
    return { room, participant };
  }

  private connectedCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) for (const p of room.participants.values()) if (p.connected) count += 1;
    return count;
  }

  snapshot({ room, participant }: AnimationAuth): AnimationSnapshot {
    return {
      id: room.id, revision: ++room.revision, expiresAt: room.expiresAt, hostConnected: [...room.participants.values()].some((p) => p.connected && p.role === 'host'),
      selfId: participant.id, role: participant.role,
      participants: [...room.participants.values()].map(({ token: _token, lastSeen: _lastSeen, revoked: _revoked, activeAttempt: _activeAttempt, ...visible }) => ({ ...visible })),
      job: room.job ? { ...room.job.public, settings: { ...room.job.public.settings }, frames: [...room.job.public.frames], frameOwners: { ...room.job.public.frameOwners } } : null,
    };
  }

  consent(auth: AnimationAuth, enabled: boolean): AnimationSnapshot {
    if (!enabled) this.releaseParticipant(auth.room, auth.participant);
    auth.participant.consented = enabled;
    return this.snapshot(auth);
  }

  private requireHost(auth: AnimationAuth): void { if (auth.participant.role !== 'host') fail(403, 'HOST_REQUIRED', '방장만 변경할 수 있어요.'); }

  async start(auth: AnimationAuth, input: AnimationSettings): Promise<AnimationSnapshot> {
    this.requireHost(auth);
    const settings = animationSettingsSchema.parse(input);
    const room = auth.room;
    if (room.starting || room.job?.public.status === 'rendering' || room.job?.public.status === 'encoding') fail(409, 'JOB_ACTIVE', '현재 작업을 마친 뒤 시작해 주세요.');
    room.starting = true;
    try {
      if (room.job) { await this.cleanup(room.job); room.job = null; }
      if (this.closed || this.rooms.get(room.id) !== room) fail(404, 'ROOM_NOT_FOUND', '작업실이 만료됐어요.');
      const reservedBytes = settings.width * settings.height * settings.frames * 3 + settings.frames * 320 * 180 * 4 + 64 * 1024 * 1024;
      const allocatedBytes = [...this.allocations].reduce((sum, job) => sum + job.reservedBytes, 0);
      if ([...this.allocations].filter((job) => ['rendering', 'encoding'].includes(job.public.status)).length >= MAX_ALLOCATIONS) fail(503, 'RENDER_CAPACITY', '다른 영상 작업이 끝난 뒤 다시 시작해 주세요.');
      if (allocatedBytes + reservedBytes > MAX_DISK_BYTES) fail(503, 'STORAGE_CAPACITY', '영상 보관 공간이 가득 찼어요. 이전 작업실이 만료된 뒤 다시 시도해 주세요.');
      const jobId = id();
      const job: Job = {
        public: { id: jobId, status: 'rendering', settings, totalFrames: settings.frames, completedFrames: 0, frames: [], frameOwners: {}, retries: 0,
          startedAt: this.now(), finishedAt: null, renderMs: null, encodeMs: null, wallMs: null, computeMs: 0, resultBytes: 0, videoBytes: 0, failureReason: null },
        directory: '', reservedBytes, frames: Array.from({ length: settings.frames }, (_, index) => ({ index, owner: null, attemptId: null, startedAt: 0, expiresAt: 0, rows: 0, attempts: 0, done: false, uploading: false })),
        uploads: new Set(), encoder: null, encoding: null, cleanup: null,
      };
      this.allocations.add(job);
      try { job.directory = await this.files.createJob(jobId); }
      catch (error) { this.allocations.delete(job); throw error; }
      if (this.closed || this.rooms.get(room.id) !== room) { await this.cleanup(job); fail(404, 'ROOM_NOT_FOUND', '작업실이 만료됐어요.'); }
      room.job = job;
      for (const p of room.participants.values()) { p.completedFrames = 0; p.computeMs = 0; p.activeFrame = null; p.activeAttempt = null; }
      return this.snapshot(auth);
    } finally { room.starting = false; }
  }

  cancel(auth: AnimationAuth): AnimationSnapshot {
    this.requireHost(auth);
    if (auth.room.job && ['rendering', 'encoding'].includes(auth.room.job.public.status)) this.finish(auth.room, 'cancelled');
    return this.snapshot(auth);
  }

  task(auth: AnimationAuth): AnimationAssignment | null {
    if (!auth.participant.consented) fail(403, 'CONSENT_REQUIRED', '기기 자원 사용에 동의한 뒤 참여해 주세요.');
    const job = auth.room.job;
    if (!job || job.public.status !== 'rendering') return null;
    const existing = job.frames.find((frame) => frame.owner === auth.participant.id && frame.attemptId === auth.participant.activeAttempt && !frame.done);
    if (existing) {
      if (existing.expiresAt <= this.now() || this.now() - existing.startedAt >= this.config.animationMaxAttemptMs) this.release(auth.room, existing);
      else return this.assignment(job, existing);
    }
    const frame = job.frames.find((entry) => !entry.done && !entry.owner && !entry.uploading);
    if (!frame || job.public.status !== 'rendering') return null;
    frame.owner = auth.participant.id; frame.attemptId = id(); frame.startedAt = this.now(); frame.expiresAt = this.now() + Math.min(this.config.leaseMs, this.config.animationMaxAttemptMs);
    frame.rows = 0; frame.attempts += 1;
    auth.participant.activeFrame = frame.index; auth.participant.activeAttempt = frame.attemptId;
    return this.assignment(job, frame);
  }

  private assignment(job: Job, frame: Frame): AnimationAssignment {
    return { task: { jobId: job.public.id, taskId: `${job.public.id}:${frame.index}`, frameIndex: frame.index, settings: job.public.settings, algorithmVersion: ANIMATION_ALGORITHM }, attemptId: frame.attemptId!, leaseExpiresAt: frame.expiresAt };
  }

  private active(auth: AnimationAuth, attempt: Attempt): { job: Job; frame: Frame } {
    const job = auth.room.job;
    const frame = job?.frames.find((entry) => `${job.public.id}:${entry.index}` === attempt.taskId);
    if (!job || job.public.id !== attempt.jobId || job.public.status !== 'rendering' || !frame || frame.done || frame.owner !== auth.participant.id || frame.attemptId !== attempt.attemptId
      || !auth.participant.consented || !auth.participant.connected || frame.expiresAt <= this.now() || this.now() - frame.startedAt >= this.config.animationMaxAttemptMs) fail(409, 'STALE_ATTEMPT', '다시 배정된 작업이에요.');
    return { job, frame };
  }

  progress(auth: AnimationAuth, attempt: Attempt, rows: number): void {
    const { job, frame } = this.active(auth, attempt);
    if (!Number.isInteger(rows) || rows < 0 || rows > job.public.settings.height) fail(400, 'INVALID_PROGRESS', '진행 정보가 올바르지 않아요.');
    // HTTP progress reports can arrive out of order; old rows never renew a lease.
    if (rows > frame.rows) { frame.rows = rows; frame.expiresAt = Math.min(this.now() + this.config.leaseMs, frame.startedAt + this.config.animationMaxAttemptMs); }
  }

  reserveUpload(auth: AnimationAuth, attempt: Attempt): UploadReservation {
    const { job, frame } = this.active(auth, attempt);
    if (frame.uploading) fail(409, 'UPLOAD_IN_PROGRESS', '이미 전송 중인 프레임이에요.');
    if (this.uploading >= 4) fail(429, 'UPLOAD_BUSY', '잠시 후 프레임을 다시 전송해 주세요.');
    frame.uploading = true; this.uploading += 1;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    job.uploads.add(pending);
    let done = false;
    return { auth, job, frame, finish: () => {
      if (done) return;
      done = true; frame.uploading = false; this.uploading -= 1; job.uploads.delete(pending); resolve();
    } };
  }

  async result(reservation: UploadReservation, attempt: Attempt, pixels: Buffer, computeMs: number): Promise<void> {
    const { auth, job, frame } = reservation;
    this.active(auth, attempt);
    const settings = job.public.settings;
    if (pixels.length !== settings.width * settings.height * 4 || !Number.isFinite(computeMs) || computeMs < 0 || computeMs > this.config.animationMaxAttemptMs) {
      this.release(auth.room, frame); fail(400, 'INVALID_RESULT', '프레임 크기 또는 계산 시간이 올바르지 않아요.');
    }
    for (let sample = 0; sample < 8; sample += 1) {
      const offset = randomInt(settings.width * settings.height);
      const expected = renderAnimationPixel(settings, frame.index, offset % settings.width, Math.floor(offset / settings.width));
      if (expected.some((value, channel) => Math.abs(value - pixels[offset * 4 + channel]!) > (channel === 3 ? 0 : 1))) {
        this.release(auth.room, frame); fail(422, 'INVALID_PIXELS', '계산 결과를 확인하지 못해 다시 배정했어요.');
      }
    }
    const prepared = await this.files.prepareFrame(job.directory, frame.index, attempt.attemptId, settings.width, settings.height, pixels);
    try {
      this.active(auth, attempt);
      await prepared.commit();
      // Cancellation, consent withdrawal and lease expiry may happen during disk I/O.
      this.active(auth, attempt);
      frame.done = true; frame.owner = null; frame.attemptId = null;
      auth.participant.activeFrame = null; auth.participant.activeAttempt = null;
      auth.participant.completedFrames += 1; auth.participant.computeMs += computeMs;
      job.public.completedFrames += 1; job.public.frames.push(frame.index); job.public.frames.sort((a, b) => a - b);
      job.public.frameOwners[String(frame.index)] = auth.participant.id;
      job.public.computeMs += computeMs; job.public.resultBytes += pixels.length;
      if (job.public.completedFrames === job.public.totalFrames) this.beginEncoding(auth.room, job);
    } finally { await prepared.discard(); }
  }

  taskError(auth: AnimationAuth, attempt: Attempt): void { this.release(auth.room, this.active(auth, attempt).frame); }

  leave(auth: AnimationAuth): void {
    this.releaseParticipant(auth.room, auth.participant);
    auth.participant.consented = false; auth.participant.connected = false; auth.participant.revoked = true;
  }

  private releaseParticipant(room: Room, participant: Participant): void {
    const frame = room.job?.frames.find((entry) => entry.owner === participant.id && !entry.done);
    if (frame) this.release(room, frame);
    participant.activeFrame = null; participant.activeAttempt = null;
  }

  private release(room: Room, frame: Frame): void {
    if (!frame.owner || frame.done) return;
    const owner = room.participants.get(frame.owner);
    if (owner?.activeAttempt === frame.attemptId) { owner.activeFrame = null; owner.activeAttempt = null; }
    frame.owner = null; frame.attemptId = null;
    const job = room.job!;
    job.public.retries += 1;
    if (frame.attempts > this.config.maxRetries && job.public.status === 'rendering') this.finish(room, 'failed', '반복해서 중단된 프레임이 있어요. 다시 시작해 주세요.');
  }

  private clearConsent(room: Room): void {
    for (const p of room.participants.values()) { p.consented = false; p.activeFrame = null; p.activeAttempt = null; }
  }

  private finish(room: Room, status: 'cancelled' | 'failed', reason: string | null = null): void {
    const job = room.job!;
    job.public.status = status; job.public.failureReason = reason;
    job.public.finishedAt = this.now(); job.public.wallMs = this.now() - job.public.startedAt;
    this.clearConsent(room);
    for (const frame of job.frames) { frame.owner = null; frame.attemptId = null; }
    this.scheduleCleanup(job);
  }

  private beginEncoding(room: Room, job: Job): void {
    job.public.status = 'encoding'; job.public.renderMs = this.now() - job.public.startedAt;
    const encodingStarted = this.now();
    this.clearConsent(room);
    job.encoding = (async () => {
      try {
        const encoder = this.files.encode(job.directory, job.public.settings.frames, job.public.settings.fps);
        job.encoder = encoder.process;
        await encoder.completed;
        if (room.job !== job || job.public.status !== 'encoding') return;
        job.public.videoBytes = (await stat(join(job.directory, 'animation.mp4'))).size;
        if (room.job !== job || job.public.status !== 'encoding') return;
        job.public.status = 'completed'; job.public.finishedAt = this.now();
        job.public.encodeMs = this.now() - encodingStarted; job.public.wallMs = this.now() - job.public.startedAt;
      } catch {
        if (room.job === job && job.public.status === 'encoding') this.finish(room, 'failed', '영상을 저장하지 못했어요. 서버의 FFmpeg 설정을 확인해 주세요.');
      } finally { job.encoder = null; }
    })();
  }

  preview(auth: AnimationAuth, jobId: string, frameIndex: number) {
    const job = auth.room.job;
    if (!job || job.public.id !== jobId || !Number.isInteger(frameIndex) || !job.frames[frameIndex]?.done || !['rendering', 'encoding', 'completed'].includes(job.public.status)) fail(404, 'FRAME_NOT_FOUND', '아직 완성되지 않은 프레임이에요.');
    return this.files.preview(job.directory, frameIndex);
  }

  video(auth: AnimationAuth, jobId: string) {
    const job = auth.room.job;
    if (!job || job.public.id !== jobId || job.public.status !== 'completed') fail(404, 'VIDEO_NOT_READY', '아직 영상이 완성되지 않았어요.');
    return this.files.video(job.directory);
  }

  sweep(): void {
    for (const room of this.rooms.values()) {
      if (room.expiresAt <= this.now() || this.now() - room.lastActiveAt >= this.config.idleRoomTtlMs) {
        this.rooms.delete(room.id);
        if (room.job) { if (['rendering', 'encoding'].includes(room.job.public.status)) this.finish(room, 'cancelled'); else this.scheduleCleanup(room.job); }
        continue;
      }
      for (const participant of room.participants.values()) if (participant.connected && this.now() - participant.lastSeen >= this.config.heartbeatTimeoutMs) {
        this.releaseParticipant(room, participant); participant.connected = false; participant.consented = false;
      }
      const job = room.job;
      if (!job || !['rendering', 'encoding'].includes(job.public.status)) continue;
      if (this.now() - job.public.startedAt >= JOB_DEADLINE_MS) { this.finish(room, 'failed', '작업 시간이 30분을 넘었어요. 더 가벼운 설정으로 다시 시작해 주세요.'); continue; }
      for (const frame of job.frames) if (frame.owner && (frame.expiresAt <= this.now() || this.now() - frame.startedAt >= this.config.animationMaxAttemptMs)) this.release(room, frame);
    }
  }

  private scheduleCleanup(job: Job): void {
    const pending = this.cleanup(job);
    this.cleanups.add(pending);
    void pending.finally(() => this.cleanups.delete(pending)).catch(() => { /* close retries removing the private root */ });
  }

  private cleanup(job: Job): Promise<void> {
    if (!job.cleanup) job.cleanup = (async () => {
      job.encoder?.kill();
      await Promise.all([...job.uploads]);
      if (job.encoding) await job.encoding;
      if (job.directory) await this.files.removeJob(job.directory);
      this.allocations.delete(job);
    })();
    return job.cleanup;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const room of this.rooms.values()) if (room.job && ['rendering', 'encoding'].includes(room.job.public.status)) this.finish(room, 'cancelled');
    await Promise.all([...this.allocations].map((job) => this.cleanup(job)));
    await Promise.all(this.cleanups);
    this.rooms.clear();
    await this.files.close();
  }
}
