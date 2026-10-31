import { randomUUID } from 'node:crypto';
export class Room {
  persistent = false;
  startData: unknown = null;
  sessionState: Buffer = Buffer.alloc(0);
  revision = 0;
  updatedAt = Date.now();
  upload: { id: string; owner: string; generation: number; revision: number; bytes: Buffer; offset: number; at: number } | null = null;
  readonly active = new Set<string>();
  readonly reservations = new Set<string>();
  gameStarted = false;
  joinClosed = false;
  fixedRoster = false;
  hostMigration = false;
  hostGeneration = 0;
  binaryRelay = false;
  readonly gamePlayers = new Set<string>();
  readonly pushEvents = new Set<string>();
  lastPushAt = 0;
  canRejoin(playerId: string): boolean {
    return this.fixedRoster ? this.gamePlayers.has(playerId) : this.reservations.has(playerId);
  }
  roomMeta: unknown = null;
  constructor(public roomName: string, public ownerId: string, public maxPlayers: number,
    public password: string | null, public gameData: unknown, readonly roomId: string = randomUUID()) {}
  toNetObject(rtt: number | null = null) {
    return { roomId: this.roomId, ownerId: this.ownerId, name: this.roomName,
      players: [...this.active], maxPlayers: this.maxPlayers, hasPassword: this.password !== null,
      gameData: this.gameData, gameStarted: this.gameStarted, joinClosed: this.joinClosed, rtt, metaData: this.roomMeta,
      ...(this.hostMigration ? { hostGeneration: this.hostGeneration } : {}),
      ...(this.binaryRelay ? { binaryRelay: true } : {}),
      ...(this.persistent ? { persistent: true, participants: [...this.gamePlayers] } : {}) };
  }
}
