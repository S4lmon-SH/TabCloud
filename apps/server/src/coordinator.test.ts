import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { serverMessageSchema, type ClientMessage, type ServerMessage } from '@tabcloud/shared';
import { DEFAULT_CONFIG } from './config.js';
import { Coordinator } from './coordinator.js';

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(serverMessageSchema.parse(JSON.parse(payload)));
    callback?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.close(); }
  receive(message: ClientMessage): void { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}

describe('backpressure state consistency', () => {
  it('never follows a disconnect snapshot with stale participant state from an outer broadcast', () => {
    const coordinator = new Coordinator(DEFAULT_CONFIG, () => 1_000_000);
    const credentials = coordinator.createRoom()!;
    const slow = new TestSocket();
    const observer = new TestSocket();
    coordinator.attach(slow as unknown as WebSocket);
    coordinator.attach(observer as unknown as WebSocket);
    slow.receive({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, hostToken: credentials.hostToken, name: '느린 방장' });
    observer.receive({ v: 1, type: 'join-room', roomId: credentials.roomId, inviteToken: credentials.inviteToken, name: '관찰자' });
    observer.sent = [];
    slow.bufferedAmount = DEFAULT_CONFIG.maxBufferedBytes;
    observer.receive({ v: 1, type: 'consent-compute', enabled: true });
    const snapshots = observer.sent.filter((message) => message.type === 'room-snapshot');
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((message) => !message.room.hostConnected)).toBe(true);
    expect(snapshots.at(-1)?.room.participants.filter((participant) => participant.connected)).toHaveLength(1);
    expect(coordinator.connectionCount).toBe(1);
    coordinator.close();
  });
});
