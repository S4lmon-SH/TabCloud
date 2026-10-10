import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, type RawData } from 'ws';
import { createTiles, renderPixel } from '@tabcloud/compute';
import {
  clientMessageSchema,
  type ClientMessage,
  type JobSnapshot,
  type ParticipantSnapshot,
  type RenderSettings,
  type RoomSnapshot,
  type ServerMessage,
  type TileTask,
} from '@tabcloud/shared';
import type { ServerConfig } from './config.js';

type AttemptMessage = Extract<ClientMessage, { type: 'task-result' | 'task-progress' | 'task-error' }>;
interface Lease {
  attemptId: string;
  participantId: string;
  assignedAt: number;
  until: number;
  rows: number;
}
interface TaskRecord {
  task: TileTask;
  state: 'pending' | 'leased' | 'completed';
  attempts: number;
  lease: Lease | null;
  result: { pixels: string; participantId: string } | null;
}
interface Job {
  snapshot: JobSnapshot;
  tasks: Map<string, TaskRecord>;
  pending: string[];
  reservedBytes: number;
}
interface Participant extends ParticipantSnapshot {
  connection: Connection | null;
}
interface Room {
  id: string;
  inviteToken: string;
  hostToken: string;
  expiresAt: number;
  emptySince: number | null;
  participants: Map<string, Participant>;
  waiting: Set<string>;
  job: Job | null;
  events: RoomSnapshot['events'];
  jobStarts: number[];
}
export interface Connection {
  socket: WebSocket;
  room: Room | null;
  participant: Participant | null;
  lastHeartbeat: number;
  windowAt: number;
  messageCount: number;
  closed: boolean;
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Single-process bounded scheduler. Only the eight sampled pixels are computed here. */
export class Coordinator {
  private rooms = new Map<string, Room>();
  private connections = new Set<Connection>();
  private reservedBytes = 0;

  constructor(readonly config: ServerConfig, private readonly now = Date.now) {}

  get roomCount(): number { return this.rooms.size; }
  get connectionCount(): number { return this.connections.size; }
  get resultMemoryReserved(): number { return this.reservedBytes; }

  createRoom(): { roomId: string; inviteToken: string; hostToken: string; expiresAt: number } | null {
    this.sweep();
    if (this.rooms.size >= this.config.maxRooms) return null;
    const room: Room = {
      id: randomBytes(12).toString('base64url'),
      inviteToken: randomBytes(32).toString('base64url'),
      hostToken: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + this.config.roomTtlMs,
      emptySince: this.now(),
      participants: new Map(), waiting: new Set(), job: null, events: [], jobStarts: [],
    };
    this.rooms.set(room.id, room);
    return { roomId: room.id, inviteToken: room.inviteToken, hostToken: room.hostToken, expiresAt: room.expiresAt };
  }

  attach(socket: WebSocket): Connection {
    const connection: Connection = {
      socket, room: null, participant: null, lastHeartbeat: this.now(),
      windowAt: this.now(), messageCount: 0, closed: false,
    };
    this.connections.add(connection);
    socket.on('message', (data, binary) => this.receive(connection, data, binary));
    socket.on('close', () => this.detach(connection));
    socket.on('error', () => this.detach(connection));
    return connection;
  }

  private send(connection: Connection, message: ServerMessage, callback?: () => void): boolean {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(message);
    if (connection.socket.bufferedAmount + Buffer.byteLength(payload) > this.config.maxBufferedBytes) {
      connection.socket.close(1013, 'Slow receiver; reconnect to replay');
      this.detach(connection);
      return false;
    }
    connection.socket.send(payload, (error) => {
      if (error) { connection.socket.terminate(); this.detach(connection); }
      else callback?.();
    });
    return true;
  }

  private error(connection: Connection, code: string, message: string): void {
    this.send(connection, { v: 1, type: 'error', code, message });
  }

  private reject(connection: Connection, message: Pick<AttemptMessage, 'jobId' | 'taskId' | 'attemptId'>, reason: string): void {
    this.send(connection, { v: 1, type: 'task-rejected', jobId: message.jobId, taskId: message.taskId, attemptId: message.attemptId, reason });
  }

  private receive(connection: Connection, data: RawData, binary: boolean): void {
    if (connection.closed) return;
    const now = this.now();
    if (now - connection.windowAt >= 1000) { connection.windowAt = now; connection.messageCount = 0; }
    if (++connection.messageCount > this.config.maxMessagesPerSecond) {
      this.error(connection, 'RATE_LIMITED', '메시지 요청이 너무 많습니다. 잠시 후 다시 연결하세요.');
      connection.socket.close(1008, 'Rate limit');
      this.detach(connection);
      return;
    }
    if (binary) { this.error(connection, 'INVALID_MESSAGE', 'JSON 텍스트 메시지만 지원합니다.'); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString()); }
    catch { this.error(connection, 'INVALID_MESSAGE', '올바른 JSON 메시지가 아닙니다.'); return; }
    const validated = clientMessageSchema.safeParse(parsed);
    if (!validated.success) { this.error(connection, 'INVALID_MESSAGE', '메시지 형식 또는 허용 범위를 확인하세요.'); return; }
    const message = validated.data;
    if (message.type === 'join-room') { this.join(connection, message); return; }
    if (!connection.room || !connection.participant) { this.error(connection, 'JOIN_REQUIRED', '먼저 방에 참여하세요.'); return; }
    const room = connection.room;
    const participant = connection.participant;
    if (now >= room.expiresAt) { this.expire(room); return; }
    switch (message.type) {
      case 'heartbeat':
        connection.lastHeartbeat = now;
        this.send(connection, { v: 1, type: 'heartbeat-ack' });
        return;
      case 'leave-room':
        this.detach(connection);
        connection.socket.close(1000, 'Left room');
        return;
      case 'consent-compute':
        participant.consented = message.enabled;
        if (!message.enabled) {
          room.waiting.delete(participant.id);
          this.releaseLease(room, participant, '참여자가 연산을 중단했습니다.');
        }
        this.broadcastSnapshot(room);
        this.dispatch(room);
        return;
      case 'request-task':
        if (!participant.consented) { this.error(connection, 'CONSENT_REQUIRED', '연산 참여 동의가 필요합니다.'); return; }
        if (!participant.activeTaskId) room.waiting.add(participant.id);
        this.dispatch(room);
        return;
      case 'start-job':
        if (participant.role !== 'host') { this.error(connection, 'HOST_REQUIRED', '방장만 작업을 시작할 수 있습니다.'); return; }
        this.startJob(room, connection, message.settings);
        return;
      case 'cancel-job':
        if (participant.role !== 'host') { this.error(connection, 'HOST_REQUIRED', '방장만 작업을 취소할 수 있습니다.'); return; }
        if (room.job?.snapshot.id !== message.jobId || room.job.snapshot.status !== 'running') {
          this.error(connection, 'NO_RUNNING_JOB', '취소할 실행 중인 작업이 없습니다.'); return;
        }
        this.finishJob(room, 'cancelled');
        this.broadcast(room, { v: 1, type: 'job-cancelled', jobId: message.jobId });
        this.broadcastSnapshot(room);
        return;
      case 'task-progress': {
        const record = this.currentLease(room, participant, message);
        if (!record?.lease) { this.reject(connection, message, 'STALE_ATTEMPT'); return; }
        if (message.rows > record.task.height || message.rows <= record.lease.rows) return;
        record.lease.rows = message.rows;
        record.lease.until = Math.min(now + this.config.leaseMs, record.lease.assignedAt + this.config.maxAttemptMs);
        return;
      }
      case 'task-error': {
        const record = this.currentLease(room, participant, message);
        if (!record) { this.reject(connection, message, 'STALE_ATTEMPT'); return; }
        this.releaseLease(room, participant, '참여 브라우저가 타일 계산 오류를 보고했습니다.');
        this.reject(connection, message, 'WORKER_ERROR');
        this.broadcastSnapshot(room);
        this.dispatch(room);
        return;
      }
      case 'task-result':
        this.acceptResult(room, participant, connection, message);
    }
  }

  private join(connection: Connection, message: Extract<ClientMessage, { type: 'join-room' }>): void {
    if (connection.room) { this.error(connection, 'ALREADY_JOINED', '이미 방에 참여 중입니다.'); return; }
    const room = this.rooms.get(message.roomId);
    if (!room || this.now() >= room.expiresAt) {
      if (room) this.expire(room);
      this.error(connection, 'ROOM_NOT_FOUND', '방이 없거나 만료되었습니다. 서버 재시작 후에도 방이 사라집니다.');
      return;
    }
    if (!sameToken(message.inviteToken, room.inviteToken)) { this.error(connection, 'INVALID_INVITE', '초대 링크가 올바르지 않습니다.'); return; }
    if (message.hostToken !== undefined && !sameToken(message.hostToken, room.hostToken)) {
      this.error(connection, 'INVALID_HOST_TOKEN', '방장 인증 정보가 올바르지 않습니다.'); return;
    }
    const connected = [...room.participants.values()].filter((participant) => participant.connected).length;
    if (connected >= this.config.maxParticipants) { this.error(connection, 'ROOM_FULL', '방 참여자 한도에 도달했습니다.'); return; }
    while (room.participants.size >= this.config.maxParticipantHistory) {
      const oldest = [...room.participants.values()].find((participant) => !participant.connected);
      if (!oldest) { this.error(connection, 'ROOM_FULL', '방 참여자 기록 한도에 도달했습니다.'); return; }
      room.participants.delete(oldest.id);
    }
    const participant: Participant = {
      id: randomUUID(), name: message.name, role: message.hostToken ? 'host' : 'participant',
      connected: true, consented: false, completedTasks: 0, computeMs: 0, activeTaskId: null, connection,
    };
    room.participants.set(participant.id, participant);
    room.emptySince = null;
    connection.room = room;
    connection.participant = participant;
    connection.lastHeartbeat = this.now();
    this.event(room, `${participant.name} 님이 연결했습니다.`);
    this.broadcastSnapshot(room);
    this.replay(connection, room);
  }

  private replay(connection: Connection, room: Room): void {
    const job = room.job;
    if (!job) return;
    const completed = [...job.tasks.values()].filter((record) => record.state === 'completed');
    let next = 0;
    const sendNext = () => {
      if (connection.closed || connection.room !== room || room.job !== job) return;
      const record = completed[next++];
      if (!record?.result) return;
      this.send(connection, { v: 1, type: 'tile-completed', task: record.task, ...record.result }, () => setImmediate(sendNext));
    };
    sendNext();
  }

  private startJob(room: Room, connection: Connection, settings: RenderSettings): void {
    if (room.job?.snapshot.status === 'running') { this.error(connection, 'JOB_RUNNING', '진행 중인 작업을 먼저 취소하세요.'); return; }
    room.jobStarts = room.jobStarts.filter((at) => this.now() - at < 60_000);
    if (room.jobStarts.length >= 10) { this.error(connection, 'RATE_LIMITED', '작업 시작은 방마다 분당 10회까지 가능합니다.'); return; }
    // Reserve worst-case base64 + task metadata before accepting the job; no unbounded result growth.
    const tileCount = Math.ceil(settings.width / settings.tileSize) * Math.ceil(settings.height / settings.tileSize);
    const reserved = Math.ceil(settings.width * settings.height * 4 / 3) * 4 + tileCount * 1024;
    const replaced = room.job?.reservedBytes ?? 0;
    if (reserved > this.config.maxJobBytes || this.reservedBytes - replaced + reserved > this.config.maxTotalResultBytes) {
      this.error(connection, 'MEMORY_LIMIT', '서버 결과 메모리 한도에 도달했습니다. 해상도를 줄이거나 나중에 다시 시도하세요.'); return;
    }
    const id = randomUUID();
    const tiles = createTiles(id, settings);
    room.job = {
      snapshot: {
        id, status: 'running', settings, totalTasks: tiles.length, completedTasks: 0, retries: 0,
        startedAt: this.now(), finishedAt: null, wallMs: null, computeMs: 0, validationMs: 0,
        roundTripMs: 0, resultBytes: 0, failureReason: null,
      },
      tasks: new Map(tiles.map((task) => [task.taskId, { task, state: 'pending', attempts: 0, lease: null, result: null }])),
      pending: tiles.map((task) => task.taskId), reservedBytes: reserved,
    };
    this.reservedBytes += reserved - replaced;
    room.jobStarts.push(this.now());
    for (const participant of room.participants.values()) {
      participant.completedTasks = 0; participant.computeMs = 0; participant.activeTaskId = null;
    }
    this.event(room, `${tiles.length}개 타일 렌더링을 시작했습니다.`);
    this.broadcastSnapshot(room);
    this.dispatch(room);
  }

  private dispatch(room: Room): void {
    const job = room.job;
    if (!job || job.snapshot.status !== 'running') return;
    let assigned = false;
    for (const id of room.waiting) {
      if (!job.pending.length) break;
      room.waiting.delete(id);
      const participant = room.participants.get(id);
      if (!participant?.connected || !participant.consented || participant.activeTaskId || !participant.connection) continue;
      const taskId = job.pending.shift();
      const record = taskId ? job.tasks.get(taskId) : undefined;
      if (!record || record.state !== 'pending') continue;
      const now = this.now();
      const lease: Lease = { attemptId: randomUUID(), participantId: id, assignedAt: now, until: now + Math.min(this.config.leaseMs, this.config.maxAttemptMs), rows: 0 };
      record.state = 'leased'; record.attempts++; record.lease = lease;
      participant.activeTaskId = record.task.taskId;
      this.send(participant.connection, { v: 1, type: 'task-assigned', task: record.task, attemptId: lease.attemptId, leaseUntil: lease.until });
      assigned = true;
    }
    if (assigned) this.broadcastSnapshot(room);
  }

  private currentLease(room: Room, participant: Participant, message: AttemptMessage): TaskRecord | null {
    const job = room.job;
    if (!job || job.snapshot.id !== message.jobId || job.snapshot.status !== 'running') return null;
    const record = job.tasks.get(message.taskId);
    if (record?.state !== 'leased' || record.lease?.attemptId !== message.attemptId || record.lease.participantId !== participant.id) return null;
    if (this.now() >= record.lease.until) {
      this.releaseLease(room, participant, '타일 lease가 만료되어 재배정합니다.');
      this.broadcastSnapshot(room);
      this.dispatch(room);
      return null;
    }
    return record;
  }

  private acceptResult(room: Room, participant: Participant, connection: Connection, message: Extract<ClientMessage, { type: 'task-result' }>): void {
    const record = this.currentLease(room, participant, message);
    if (!record?.lease || !room.job) { this.reject(connection, message, 'STALE_ATTEMPT'); return; }
    const job = room.job;
    const expectedBytes = record.task.width * record.task.height * 4;
    let valid = message.pixels.length === Math.ceil(expectedBytes / 3) * 4;
    const started = performance.now();
    const pixels = valid ? Buffer.from(message.pixels, 'base64') : Buffer.alloc(0);
    valid = valid && pixels.length === expectedBytes && pixels.toString('base64') === message.pixels;
    if (valid) {
      const count = record.task.width * record.task.height;
      const samples = new Set([0, count - 1]);
      while (samples.size < Math.min(8, count)) samples.add(randomInt(count));
      for (const index of samples) {
        const rgba = renderPixel(record.task.settings, record.task.x + index % record.task.width, record.task.y + Math.floor(index / record.task.width));
        if (rgba.some((channel, offset) => channel !== pixels[index * 4 + offset])) { valid = false; break; }
      }
    }
    job.snapshot.validationMs += performance.now() - started;
    if (!valid) {
      this.releaseLease(room, participant, '타일 결과 검증에 실패하여 재배정합니다.');
      this.reject(connection, message, 'INVALID_PIXELS');
      this.broadcastSnapshot(room);
      this.dispatch(room);
      return;
    }
    job.snapshot.roundTripMs += Math.max(0, this.now() - record.lease.assignedAt);
    // Bound untrusted diagnostic timing, independently from server wall-clock metrics.
    const computeMs = Math.min(message.computeMs, this.config.maxAttemptMs);
    job.snapshot.computeMs += computeMs;
    job.snapshot.resultBytes += expectedBytes;
    job.snapshot.completedTasks++;
    participant.completedTasks++;
    participant.computeMs += computeMs;
    participant.activeTaskId = null;
    record.state = 'completed'; record.lease = null;
    record.result = { pixels: message.pixels, participantId: participant.id };
    this.send(connection, { v: 1, type: 'task-accepted', jobId: message.jobId, taskId: message.taskId, attemptId: message.attemptId });
    this.broadcast(room, { v: 1, type: 'tile-completed', task: record.task, ...record.result });
    if (job.snapshot.completedTasks === job.snapshot.totalTasks && [...job.tasks.values()].every((task) => task.state === 'completed')) {
      this.finishJob(room, 'completed');
    }
    this.broadcastSnapshot(room);
    this.dispatch(room);
  }

  private releaseLease(room: Room, participant: Participant, reason: string): void {
    const taskId = participant.activeTaskId;
    participant.activeTaskId = null;
    if (!taskId || !room.job || room.job.snapshot.status !== 'running') return;
    const record = room.job.tasks.get(taskId);
    if (record?.state !== 'leased' || record.lease?.participantId !== participant.id) return;
    record.lease = null;
    room.job.snapshot.retries++;
    this.event(room, reason);
    if (record.attempts > this.config.maxRetries) {
      this.finishJob(room, 'failed', '타일 재시도 한도를 초과했습니다. 연결 또는 브라우저 계산 상태를 확인하세요.');
      return;
    }
    record.state = 'pending';
    room.job.pending.push(record.task.taskId);
  }

  private finishJob(room: Room, status: 'completed' | 'cancelled' | 'failed', reason: string | null = null): void {
    const job = room.job;
    if (!job || job.snapshot.status !== 'running') return;
    job.snapshot.status = status;
    job.snapshot.finishedAt = this.now();
    job.snapshot.wallMs = Math.max(0, this.now() - (job.snapshot.startedAt ?? this.now()));
    job.snapshot.failureReason = reason;
    job.pending = [];
    room.waiting.clear();
    for (const record of job.tasks.values()) record.lease = null;
    for (const participant of room.participants.values()) {
      participant.activeTaskId = null;
      if (status !== 'completed') participant.consented = false;
    }
    this.event(room, status === 'completed' ? '모든 타일 렌더링이 완료되었습니다.' : status === 'cancelled' ? '방장이 작업을 취소했습니다.' : reason ?? '작업이 실패했습니다.');
  }

  private event(room: Room, message: string): void {
    room.events.push({ at: this.now(), message });
    if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
  }

  private snapshot(room: Room): RoomSnapshot {
    return {
      id: room.id, expiresAt: room.expiresAt,
      hostConnected: [...room.participants.values()].some((participant) => participant.connected && participant.role === 'host'),
      participants: [...room.participants.values()].map(({ connection: _connection, ...participant }) => participant),
      job: room.job?.snapshot ?? null, events: room.events,
    };
  }

  private broadcastSnapshot(room: Room): void {
    for (const participant of room.participants.values()) {
      // send() can synchronously detach a slow receiver and reassign its lease.
      // Build each snapshot after earlier sends so a nested broadcast is never followed by stale state.
      if (participant.connection) this.send(participant.connection, { v: 1, type: 'room-snapshot', room: this.snapshot(room), selfId: participant.id, role: participant.role });
    }
  }

  private broadcast(room: Room, message: ServerMessage): void {
    for (const participant of room.participants.values()) if (participant.connection) this.send(participant.connection, message);
  }

  private detach(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    const { room, participant } = connection;
    connection.room = null; connection.participant = null;
    if (!room || !participant) return;
    participant.connected = false; participant.consented = false; participant.connection = null;
    room.waiting.delete(participant.id);
    this.releaseLease(room, participant, '참여자 연결 종료로 미완료 타일을 재배정합니다.');
    this.event(room, `${participant.name} 님의 연결이 종료되었습니다.`);
    if (![...room.participants.values()].some((entry) => entry.connected)) room.emptySince = this.now();
    this.broadcastSnapshot(room);
    this.dispatch(room);
  }

  private expire(room: Room): void {
    if (!this.rooms.delete(room.id)) return;
    this.reservedBytes -= room.job?.reservedBytes ?? 0;
    for (const participant of room.participants.values()) {
      const connection = participant.connection;
      if (!connection) continue;
      this.error(connection, 'ROOM_EXPIRED', '방이 만료되었습니다. 새 방을 만들어 주세요.');
      connection.room = null; connection.participant = null;
      this.detach(connection);
      connection.socket.close(1000, 'Room expired');
    }
    room.job = null; room.participants.clear(); room.waiting.clear();
  }

  /** Public for deterministic lifecycle tests; production invokes it on a bounded timer. */
  sweep(): void {
    const now = this.now();
    for (const connection of this.connections) {
      if (now - connection.lastHeartbeat >= this.config.heartbeatTimeoutMs) {
        this.error(connection, 'HEARTBEAT_TIMEOUT', '연결 응답이 없어 종료되었습니다. 다시 연결하세요.');
        connection.socket.close(1001, 'Heartbeat timeout');
        this.detach(connection);
      }
    }
    for (const room of this.rooms.values()) {
      if (now >= room.expiresAt || (room.emptySince !== null && now - room.emptySince >= this.config.idleRoomTtlMs)) {
        this.expire(room); continue;
      }
      const job = room.job;
      if (!job || job.snapshot.status !== 'running') continue;
      if (now - (job.snapshot.startedAt ?? now) >= this.config.maxJobMs) {
        this.finishJob(room, 'failed', '작업 실행 시간 한도를 초과했습니다.');
        this.broadcastSnapshot(room); continue;
      }
      let changed = false;
      for (const record of job.tasks.values()) {
        if (record.state !== 'leased' || !record.lease || now < record.lease.until) continue;
        const participant = room.participants.get(record.lease.participantId);
        if (!participant) continue;
        if (participant.connection) this.reject(participant.connection, { jobId: job.snapshot.id, taskId: record.task.taskId, attemptId: record.lease.attemptId }, 'LEASE_EXPIRED');
        this.releaseLease(room, participant, '타일 lease가 만료되어 재배정합니다.');
        changed = true;
      }
      if (changed) { this.broadcastSnapshot(room); this.dispatch(room); }
    }
  }

  close(): void {
    for (const connection of [...this.connections]) {
      this.detach(connection);
      connection.socket.terminate();
    }
    this.rooms.clear(); this.reservedBytes = 0;
  }
}
