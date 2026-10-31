import WebSocket from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
export type WSMessage = { method: string; data?: unknown; nextCursor?: string | null };
export class Player {
  ws: WebSocket | null = null;
  roomId: string | null = null;
  roomEntryTimestamp: number | null = null;
  rtt: number | null = null;
  offlineSince: number | null = null;
  membershipVersion = 0;
  readonly pushDevices = new Map<string, { token: string; foreground: boolean; language: string }>();
  constructor(public playerName: string, readonly playerId: string = randomUUID(), readonly password: string = randomBytes(32).toString('base64url')) {}
  toNetObject() {
    return { playerId: this.playerId, name: this.playerName, rtt: this.rtt, roomEntryTimestamp: this.roomEntryTimestamp };
  }
}
