import { randomUUID } from 'node:crypto';
export class Room {
  readonly roomId = randomUUID();
  readonly active = new Set<string>();
  readonly reservations = new Set<string>();
  gameStarted = false;
  roomMeta: unknown = null;
  constructor(public roomName: string, public ownerId: string, public maxPlayers: number,
    public password: string | null, public gameData: unknown) {}
  toNetObject(rtt: number | null = null) {
    return { roomId: this.roomId, ownerId: this.ownerId, name: this.roomName,
      players: [...this.active], maxPlayers: this.maxPlayers, hasPassword: this.password !== null,
      gameData: this.gameData, gameStarted: this.gameStarted, rtt, metaData: this.roomMeta };
  }
}
