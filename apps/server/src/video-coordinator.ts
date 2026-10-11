import { randomBytes, randomInt } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  VIDEO_ALGORITHM, VIDEO_LIMITS, videoProcessingSettingsSchema,
  type VideoAssignment, type VideoJobSnapshot, type VideoJoinResult,
  type VideoParticipant, type VideoRoomCreated, type VideoProcessingSettings, type VideoSnapshot, type VideoSourceSnapshot,
} from '@tabcloud/shared';
import { processVideoPixel } from '@tabcloud/compute';
import type { ServerConfig } from './config.js';
import { MAX_VIDEO_OUTPUT_BYTES, VideoFiles, VideoFileError } from './video-files.js';

const id = () => randomBytes(16).toString('base64url');
const token = () => randomBytes(32).toString('base64url');
const MAX_ALLOCATIONS = 2;
const MAX_DISK_BYTES = 4.5 * 1024 ** 3;
const JOB_DEADLINE_MS = 30 * 60 * 1000;

export class VideoError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new VideoError(status, code, message); }

interface Participant extends VideoParticipant {
  token: string; lastSeen: number; revoked: boolean; activeAttempt: string | null;
}
interface Frame {
  index: number; owner: string | null; attemptId: string | null; startedAt: number; expiresAt: number;
  rows: number; attempts: number; done: boolean; uploading: boolean;
}
interface Job {
  public: VideoJobSnapshot; source: Source; directory: string; frames: Frame[]; reservedBytes: number;
  uploads: Set<Promise<void>>; encoder: ChildProcess | null; encoding: Promise<void> | null;
  cleanup: Promise<void> | null;
}
interface Source {
  public: VideoSourceSnapshot; directory: string; reservedBytes: number; controller: AbortController;
  receiving: Promise<void>; preparation: Promise<void> | null; cleanup: Promise<void> | null;
}
interface Room {
  id: string; inviteToken: string; hostToken: string; expiresAt: number; lastActiveAt: number;
  participants: Map<string, Participant>; job: Job | null; starting: boolean;
  revision: number; generation: number; source: Source | null; pendingSource: Source | null;
}
export interface VideoAuth { room: Room; participant: Participant }
export interface UploadReservation { auth: VideoAuth; job: Job; frame: Frame; finish: () => void }
export interface Attempt { jobId: string; taskId: string; attemptId: string }
export interface SourceUpload { auth: VideoAuth; source: Source; receivingStarted: boolean; finish: () => void }

export class VideoCoordinator {
  readonly rooms = new Map<string, Room>();
  private readonly allocations = new Set<Job>();
  private readonly sources = new Set<Source>();
  private preparing: Source | null = null;
  private readonly cleanups = new Set<Promise<void>>();
  private uploading = 0;
  private closed = false;

  constructor(readonly files: VideoFiles, private readonly config: ServerConfig, private readonly now: () => number) {}

  createRoom(): VideoRoomCreated {
    this.sweep();
    if (this.closed || this.rooms.size >= this.config.maxRooms) fail(503, 'ROOM_LIMIT', '잠시 후 새 작업실을 만들어 주세요.');
    const room: Room = { id: id(), inviteToken: token(), hostToken: token(), expiresAt: this.now() + this.config.roomTtlMs,
      lastActiveAt: this.now(), participants: new Map(), job: null, starting: false, revision: 0, generation: 0, source: null, pendingSource: null };
    this.rooms.set(room.id, room);
    return { roomId: room.id, inviteToken: room.inviteToken, hostToken: room.hostToken, expiresAt: room.expiresAt };
  }

  private room(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room || room.expiresAt <= this.now()) fail(404, 'ROOM_NOT_FOUND', '작업실이 없거나 만료됐어요.');
    return room;
  }

  join(roomId: string, input: { inviteToken: string; hostToken?: string; name: string }): VideoJoinResult {
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
      consented: false, completedFrames: 0, computeMs: 0, activeFrame: null, activeAttempt: null, lastSeen: this.now(), revoked: false, gpuFrames: 0, cpuFrames: 0 };
    room.participants.set(participant.id, participant);
    room.lastActiveAt = this.now();
    return { participantId: participant.id, participantToken: participant.token, snapshot: this.snapshot({ room, participant }) };
  }

  auth(roomId: string, authorization: string | undefined): VideoAuth {
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

  snapshot({ room, participant }: VideoAuth): VideoSnapshot {
    return {
      id: room.id, revision: ++room.revision, expiresAt: room.expiresAt, hostConnected: [...room.participants.values()].some((p) => p.connected && p.role === 'host'),
      selfId: participant.id, role: participant.role,
      participants: [...room.participants.values()].map(({ token: _token, lastSeen: _lastSeen, revoked: _revoked, activeAttempt: _activeAttempt, ...visible }) => ({ ...visible })),
      job: room.job ? { ...room.job.public, settings: { ...room.job.public.settings }, frames: [...room.job.public.frames], frameOwners: { ...room.job.public.frameOwners } } : null,
      source: room.pendingSource || room.source ? { ...(room.pendingSource ?? room.source)!.public } : null,
    };
  }

  consent(auth: VideoAuth, enabled: boolean): VideoSnapshot {
    if (!enabled) this.releaseParticipant(auth.room, auth.participant);
    auth.participant.consented = enabled;
    return this.snapshot(auth);
  }

  private requireHost(auth: VideoAuth): void { if (auth.participant.role !== 'host') fail(403, 'HOST_REQUIRED', '방장만 변경할 수 있어요.'); }

  private allocatedBytes(): number {
    return [...this.allocations].reduce((sum, job) => sum + job.reservedBytes, 0) + [...this.sources].reduce((sum, source) => sum + source.reservedBytes, 0);
  }

  async beginUpload(auth: VideoAuth, declaredBytes?: number): Promise<SourceUpload> {
    this.requireHost(auth);
    const room = auth.room;
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > VIDEO_LIMITS.maxUploadBytes)) fail(413, 'VIDEO_TOO_LARGE', '64 MiB 이하 동영상을 선택해 주세요.');
    if (room.starting || room.pendingSource || room.job && ['rendering', 'encoding'].includes(room.job.public.status)) fail(409, 'JOB_ACTIVE', '현재 작업을 마친 뒤 업로드해 주세요.');
    if (this.preparing) fail(503, 'PREPARATION_BUSY', '다른 동영상 준비가 끝난 뒤 다시 업로드해 주세요.');
    if (this.allocatedBytes() + VIDEO_LIMITS.maxUploadBytes > MAX_DISK_BYTES) fail(503, 'STORAGE_CAPACITY', '동영상 보관 공간이 부족해요.');
    let resolveReceiving!: () => void;
    const source: Source = { public: { id: id(), status: 'preparing', width: 0, height: 0, frames: 0, fps: 24, durationSeconds: 0, sourceBytes: 0, hasAudio: false, failureReason: null },
      directory: '', reservedBytes: VIDEO_LIMITS.maxUploadBytes, controller: new AbortController(), receiving: new Promise((resolve) => { resolveReceiving = resolve; }), preparation: null, cleanup: null };
    this.sources.add(source); this.preparing = source; room.pendingSource = source;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolveReceiving(); } };
    try {
      source.directory = await this.files.createDirectory(`source-${source.public.id}`);
      if (this.closed || source.controller.signal.aborted || this.rooms.get(room.id) !== room) fail(409, 'UPLOAD_CANCELLED', '동영상 업로드가 취소됐어요.');
      return { auth, source, receivingStarted: false, finish };
    } catch (error) {
      finish(); this.sourceFailed(room, source, error); throw error;
    }
  }

  async receiveUpload(reservation: SourceUpload, stream: Readable): Promise<VideoSnapshot> {
    reservation.receivingStarted = true;
    const { auth, source, finish } = reservation; const room = auth.room;
    try {
      const received = await this.files.receive(source.directory, stream, source.controller.signal);
      finish();
      if (this.closed || source.controller.signal.aborted || room.pendingSource !== source || this.rooms.get(room.id) !== room) fail(409, 'UPLOAD_CANCELLED', '동영상 업로드가 취소됐어요.');
      source.public.sourceBytes = received.bytes;
      source.preparation = (async () => {
        try {
          const metadata = await this.files.prepare(source.directory, received.format, received.bytes, source.controller.signal, (bytes) => {
            if (this.allocatedBytes() - source.reservedBytes + bytes > MAX_DISK_BYTES) fail(503, 'STORAGE_CAPACITY', '프레임을 준비할 저장 공간이 부족해요.');
            source.reservedBytes = bytes;
          });
          if (this.closed || source.controller.signal.aborted || room.pendingSource !== source || this.rooms.get(room.id) !== room) throw new Error('Video preparation cancelled.');
          const priorSource = room.source; const priorJob = room.job;
          source.public = { ...source.public, ...metadata, status: 'ready', failureReason: null };
          room.source = source; room.pendingSource = null; room.job = null;
          if (priorJob) await this.cleanup(priorJob);
          if (priorSource) await this.cleanupSource(priorSource);
        } catch (error) { this.sourceFailed(room, source, error); }
        finally { if (this.preparing === source) this.preparing = null; }
      })();
      return this.snapshot(auth);
    } catch (error) {
      this.sourceFailed(room, source, error); throw error;
    } finally { finish(); }
  }

  abortUpload(reservation: SourceUpload, error: unknown): void {
    if (reservation.source.preparation) return;
    // Once pipeline() owns a file descriptor, its finally block must finish the
    // reservation after abort has closed that descriptor, before cleanup deletes it.
    if (!reservation.receivingStarted) reservation.finish();
    this.sourceFailed(reservation.auth.room, reservation.source, error);
  }

  private sourceFailed(room: Room, source: Source, error: unknown): void {
    const alreadyFailed = source.public.status === 'failed';
    source.controller.abort();
    source.public.status = 'failed';
    if (!alreadyFailed) source.public.failureReason = error instanceof VideoError || error instanceof VideoFileError ? error.message : '동영상 준비가 중단됐어요. 파일을 확인하고 다시 업로드해 주세요.';
    if (room.pendingSource === source) {
      room.pendingSource = null;
      if (room.source?.public.status === 'ready') room.source.public.failureReason = source.public.failureReason;
      else room.source = source;
    }
    const pending = this.cleanupSource(source);
    this.cleanups.add(pending);
    void pending.finally(() => { this.cleanups.delete(pending); if (this.preparing === source) this.preparing = null; }).catch(() => {});
  }

  async start(auth: VideoAuth, input: VideoProcessingSettings): Promise<VideoSnapshot> {
    this.requireHost(auth);
    const settings = videoProcessingSettingsSchema.parse(input);
    const room = auth.room;
    if (room.starting || room.pendingSource || room.job?.public.status === 'rendering' || room.job?.public.status === 'encoding') fail(409, 'JOB_ACTIVE', '현재 작업을 마친 뒤 시작해 주세요.');
    const source = room.source;
    if (!source || source.public.status !== 'ready') fail(409, 'SOURCE_REQUIRED', '동영상을 먼저 업로드해 주세요.');
    const generation = room.generation;
    room.starting = true;
    try {
      if (room.job) { await this.cleanup(room.job); room.job = null; }
      if (this.closed || this.rooms.get(room.id) !== room) fail(404, 'ROOM_NOT_FOUND', '작업실이 만료됐어요.');
      if (generation !== room.generation) fail(409, 'JOB_CANCELLED', '작업 시작이 취소됐어요.');
      const { width, height, frames } = source.public;
      const reservedBytes = width * height * frames * 3 + frames * 128 + MAX_VIDEO_OUTPUT_BYTES + VIDEO_LIMITS.maxFrameBytes;
      const allocatedBytes = this.allocatedBytes();
      if ([...this.allocations].filter((job) => ['rendering', 'encoding'].includes(job.public.status)).length >= MAX_ALLOCATIONS) fail(503, 'RENDER_CAPACITY', '다른 영상 작업이 끝난 뒤 다시 시작해 주세요.');
      if (allocatedBytes + reservedBytes > MAX_DISK_BYTES) fail(503, 'STORAGE_CAPACITY', '영상 보관 공간이 가득 찼어요. 이전 작업실이 만료된 뒤 다시 시도해 주세요.');
      const jobId = id();
      const job: Job = {
        public: { id: jobId, sourceId: source.public.id, width, height, fps: 24, status: 'rendering', settings, totalFrames: frames, completedFrames: 0, frames: [], frameOwners: {}, retries: 0,
          startedAt: this.now(), finishedAt: null, renderMs: null, encodeMs: null, wallMs: null, computeMs: 0, resultBytes: 0, videoBytes: 0, failureReason: null },
        source, directory: '', reservedBytes, frames: Array.from({ length: frames }, (_, index) => ({ index, owner: null, attemptId: null, startedAt: 0, expiresAt: 0, rows: 0, attempts: 0, done: false, uploading: false })),
        uploads: new Set(), encoder: null, encoding: null, cleanup: null,
      };
      this.allocations.add(job);
      try { job.directory = await this.files.createDirectory(`job-${jobId}`); }
      catch (error) { this.allocations.delete(job); throw error; }
      if (this.closed || this.rooms.get(room.id) !== room) { await this.cleanup(job); fail(404, 'ROOM_NOT_FOUND', '작업실이 만료됐어요.'); }
      if (generation !== room.generation) { await this.cleanup(job); fail(409, 'JOB_CANCELLED', '작업 시작이 취소됐어요.'); }
      room.job = job;
      for (const p of room.participants.values()) { p.completedFrames = 0; p.computeMs = 0; p.activeFrame = null; p.activeAttempt = null; p.cpuFrames = 0; p.gpuFrames = 0; }
      return this.snapshot(auth);
    } finally { room.starting = false; }
  }

  cancel(auth: VideoAuth): VideoSnapshot {
    this.requireHost(auth);
    auth.room.generation += 1;
    if (auth.room.pendingSource) this.sourceFailed(auth.room, auth.room.pendingSource, new VideoError(409, 'UPLOAD_CANCELLED', '동영상 준비를 취소했어요.'));
    if (auth.room.job && ['rendering', 'encoding'].includes(auth.room.job.public.status)) this.finish(auth.room, 'cancelled');
    return this.snapshot(auth);
  }

  task(auth: VideoAuth): VideoAssignment | null {
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

  private assignment(job: Job, frame: Frame): VideoAssignment {
    return { task: { jobId: job.public.id, taskId: `${job.public.id}:${frame.index}`, frameIndex: frame.index, width: job.public.width, height: job.public.height, settings: job.public.settings, algorithmVersion: VIDEO_ALGORITHM }, attemptId: frame.attemptId!, leaseExpiresAt: frame.expiresAt };
  }

  private active(auth: VideoAuth, attempt: Attempt): { job: Job; frame: Frame } {
    const job = auth.room.job;
    const frame = job?.frames.find((entry) => `${job.public.id}:${entry.index}` === attempt.taskId);
    if (!job || job.public.id !== attempt.jobId || job.public.status !== 'rendering' || !frame || frame.done || frame.owner !== auth.participant.id || frame.attemptId !== attempt.attemptId
      || !auth.participant.consented || !auth.participant.connected || frame.expiresAt <= this.now() || this.now() - frame.startedAt >= this.config.animationMaxAttemptMs) fail(409, 'STALE_ATTEMPT', '다시 배정된 작업이에요.');
    return { job, frame };
  }

  progress(auth: VideoAuth, attempt: Attempt, rows: number): void {
    const { job, frame } = this.active(auth, attempt);
    if (!Number.isInteger(rows) || rows < 0 || rows > job.public.height) fail(400, 'INVALID_PROGRESS', '진행 정보가 올바르지 않아요.');
    // HTTP progress reports can arrive out of order; old rows never renew a lease.
    if (rows > frame.rows) { frame.rows = rows; frame.expiresAt = Math.min(this.now() + this.config.leaseMs, frame.startedAt + this.config.animationMaxAttemptMs); }
  }

  reserveUpload(auth: VideoAuth, attempt: Attempt): UploadReservation {
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

  async result(reservation: UploadReservation, attempt: Attempt, pixels: Buffer, computeMs: number, engine: 'cpu' | 'gpu' | 'mixed' = 'cpu'): Promise<void> {
    const { auth, job, frame } = reservation;
    this.active(auth, attempt);
    const { width, height } = job.public;
    if (pixels.length !== width * height * 4 || !Number.isFinite(computeMs) || computeMs < 0 || computeMs > this.config.animationMaxAttemptMs) {
      this.release(auth.room, frame); fail(400, 'INVALID_RESULT', '프레임 크기 또는 계산 시간이 올바르지 않아요.');
    }
    const input = await this.files.sourceFrame(job.source.directory, frame.index, width, height);
    this.active(auth, attempt);
    const task = this.assignment(job, frame).task;
    for (let sample = 0; sample < 8; sample += 1) {
      const offset = randomInt(width * height);
      const expected = processVideoPixel(input, task, offset % width, Math.floor(offset / width));
      if (expected.some((value, channel) => value !== pixels[offset * 4 + channel])) {
        this.release(auth.room, frame); fail(422, 'INVALID_PIXELS', '계산 결과를 확인하지 못해 다시 배정했어요.');
      }
    }
    const prepared = await this.files.prepareFrame(job.directory, frame.index, attempt.attemptId, width, height, pixels);
    try {
      this.active(auth, attempt);
      await prepared.commit();
      // Cancellation, consent withdrawal and lease expiry may happen during disk I/O.
      this.active(auth, attempt);
      frame.done = true; frame.owner = null; frame.attemptId = null;
      auth.participant.activeFrame = null; auth.participant.activeAttempt = null;
      auth.participant.completedFrames += 1; auth.participant.computeMs += computeMs;
      // Engine contributions are client-reported; pixel validation does not prove hardware identity.
      if (engine !== 'gpu') auth.participant.cpuFrames += 1;
      if (engine !== 'cpu') auth.participant.gpuFrames += 1;
      job.public.completedFrames += 1; job.public.frames.push(frame.index); job.public.frames.sort((a, b) => a - b);
      job.public.frameOwners[String(frame.index)] = auth.participant.id;
      job.public.computeMs += computeMs; job.public.resultBytes += pixels.length;
      if (job.public.completedFrames === job.public.totalFrames) this.beginEncoding(auth.room, job);
    } finally { await prepared.discard(); }
  }

  taskError(auth: VideoAuth, attempt: Attempt): void { this.release(auth.room, this.active(auth, attempt).frame); }

  leave(auth: VideoAuth): void {
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
        const encoder = this.files.encode(job.directory, job.source.directory, job.public.totalFrames, job.source.public.hasAudio);
        job.encoder = encoder.process;
        await encoder.completed;
        if (room.job !== job || job.public.status !== 'encoding') return;
        job.public.videoBytes = (await stat(join(job.directory, 'video.mp4'))).size;
        if (room.job !== job || job.public.status !== 'encoding') return;
        job.public.status = 'completed'; job.public.finishedAt = this.now();
        job.public.encodeMs = this.now() - encodingStarted; job.public.wallMs = this.now() - job.public.startedAt;
      } catch {
        if (room.job === job && job.public.status === 'encoding') this.finish(room, 'failed', '영상을 저장하지 못했어요. 서버의 FFmpeg 설정을 확인해 주세요.');
      } finally { job.encoder = null; }
    })();
  }

  preview(auth: VideoAuth, jobId: string, frameIndex: number) {
    const job = auth.room.job;
    if (!job || job.public.id !== jobId || !Number.isInteger(frameIndex) || !job.frames[frameIndex]?.done || !['rendering', 'encoding', 'completed'].includes(job.public.status)) fail(404, 'FRAME_NOT_FOUND', '아직 완성되지 않은 프레임이에요.');
    return this.files.preview(job.directory, frameIndex, job.public.width, job.public.height);
  }

  async sourceFrame(auth: VideoAuth, attempt: Attempt, frameIndex: number): Promise<Buffer> {
    const { job, frame } = this.active(auth, attempt);
    if (frame.index !== frameIndex) fail(409, 'STALE_ATTEMPT', '배정된 프레임만 가져올 수 있어요.');
    const input = await this.files.sourceFrame(job.source.directory, frameIndex, job.public.width, job.public.height);
    this.active(auth, attempt);
    return input;
  }

  async sourcePreview(auth: VideoAuth, sourceId: string): Promise<Buffer> {
    this.requireHost(auth);
    const source = auth.room.source;
    if (!source || source.public.id !== sourceId || source.public.status !== 'ready') fail(404, 'SOURCE_NOT_READY', '아직 원본 준비가 끝나지 않았어요.');
    const input = await this.files.sourceFrame(source.directory, 0, source.public.width, source.public.height);
    return this.files.thumbnail(input, source.public.width, source.public.height);
  }

  video(auth: VideoAuth, jobId: string) {
    const job = auth.room.job;
    if (!job || job.public.id !== jobId || job.public.status !== 'completed') fail(404, 'VIDEO_NOT_READY', '아직 영상이 완성되지 않았어요.');
    return this.files.video(job.directory);
  }

  sweep(): void {
    for (const room of this.rooms.values()) {
      if (room.expiresAt <= this.now() || this.now() - room.lastActiveAt >= this.config.idleRoomTtlMs) {
        this.rooms.delete(room.id);
        if (room.job) { if (['rendering', 'encoding'].includes(room.job.public.status)) this.finish(room, 'cancelled'); else this.scheduleCleanup(room.job); }
        if (room.pendingSource) this.sourceFailed(room, room.pendingSource, new Error('Room expired.'));
        if (room.source) this.scheduleSourceCleanup(room.source);
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
      if (job.directory) await this.files.removeDirectory(job.directory);
      this.allocations.delete(job);
    })();
    return job.cleanup;
  }

  private scheduleSourceCleanup(source: Source): void {
    const pending = this.cleanupSource(source);
    this.cleanups.add(pending);
    void pending.finally(() => this.cleanups.delete(pending)).catch(() => {});
  }

  private cleanupSource(source: Source): Promise<void> {
    if (!source.cleanup) source.cleanup = (async () => {
      source.controller.abort();
      await source.receiving;
      if (source.preparation) await source.preparation;
      // A retained source is also an input to active output encoding and sample checks.
      await Promise.all([...this.allocations].filter((job) => job.source === source).map((job) => this.cleanup(job)));
      if (source.directory) { await this.files.removeDirectory(source.directory); source.directory = ''; }
      this.sources.delete(source);
    })();
    return source.cleanup;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const room of this.rooms.values()) if (room.pendingSource) this.sourceFailed(room, room.pendingSource, new Error('Server stopped.'));
    for (const room of this.rooms.values()) if (room.job && ['rendering', 'encoding'].includes(room.job.public.status)) this.finish(room, 'cancelled');
    await Promise.all([...this.allocations].map((job) => this.cleanup(job)));
    await Promise.all([...this.sources].map((source) => this.cleanupSource(source)));
    await Promise.all(this.cleanups);
    this.rooms.clear();
    await this.files.close();
  }
}
