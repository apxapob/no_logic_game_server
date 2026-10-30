import { randomUUID } from 'node:crypto';
export class Room {
  readonly roomId = randomUUID();
  readonly active = new Set<string>();
  readonly reservations = new Set<string>();
  gameStarted = false;
  joinClosed = false;
  fixedRoster = false;
  hostMigration = false;
  hostGeneration = 0;
  binaryRelay = false;
  readonly gamePlayers = new Set<string>();
  canRejoin(playerId: string): boolean {
    return this.fixedRoster ? this.gamePlayers.has(playerId) : this.reservations.has(playerId);
  }
  roomMeta: unknown = null;
  constructor(public roomName: string, public ownerId: string, public maxPlayers: number,
    public password: string | null, public gameData: unknown) {}
  toNetObject(rtt: number | null = null) {
    return { roomId: this.roomId, ownerId: this.ownerId, name: this.roomName,
      players: [...this.active], maxPlayers: this.maxPlayers, hasPassword: this.password !== null,
      gameData: this.gameData, gameStarted: this.gameStarted, joinClosed: this.joinClosed, rtt, metaData: this.roomMeta,
      ...(this.hostMigration ? { hostGeneration: this.hostGeneration } : {}),
      ...(this.binaryRelay ? { binaryRelay: true } : {}) };
  }
}
