import WebSocket from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
export type WSMessage = { method: string; data?: unknown };
export class Player {
  readonly playerId = randomUUID();
  readonly password = randomBytes(32).toString('base64url');
  ws: WebSocket | null = null;
  roomId: string | null = null;
  roomEntryTimestamp: number | null = null;
  rtt: number | null = null;
  offlineSince: number | null = null;
  membershipVersion = 0;
  constructor(public playerName: string) {}
  toNetObject() {
    return { playerId: this.playerId, name: this.playerName, rtt: this.rtt, roomEntryTimestamp: this.roomEntryTimestamp };
  }
}
