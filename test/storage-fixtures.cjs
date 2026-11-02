'use strict';
// File-format fixtures only: no server, eviction policy, protocol validation or delivery logic.
const { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
class Player {
  constructor(playerName, playerId = randomUUID(), password = randomBytes(32).toString('base64url')) {
    Object.assign(this, { playerName, playerId, password, pushDevices: new Map() });
  }
}
class Room {
  constructor(roomName, ownerId, maxPlayers, password, gameData) {
    Object.assign(this, { roomId: randomUUID(), roomName, ownerId, maxPlayers, password, gameData,
      roomMeta: null, startData: null, hostGeneration: 0, binaryRelay: false, revision: 0,
      updatedAt: Date.now(), gamePlayers: new Set(), pushEvents: new Set(), sessionState: Buffer.alloc(0) });
  }
}
class SessionStore {
  constructor(directory) {
    this.directory = directory; this.jobs = new Map();
    for (const folder of ['rooms', 'accounts', 'notifications']) mkdirSync(join(directory, folder), { recursive: true });
    for (const file of readdirSync(join(directory, 'notifications'))) {
      if (file.endsWith('.json')) this.jobs.set(file.slice(0, -5), JSON.parse(readFileSync(join(directory, 'notifications', file), 'utf8')));
    }
  }
  path(folder, id) { return join(this.directory, folder, `${id}.${folder === 'rooms' ? 'bin' : 'json'}`); }
  setJobs(id, jobs) { writeFileSync(this.path('notifications', id), JSON.stringify(jobs)); this.jobs.set(id, jobs); }
  saveAccount(p) { writeFileSync(this.path('accounts', p.playerId), JSON.stringify({ id: p.playerId, name: p.playerName, password: p.password, devices: [...p.pushDevices] })); }
  account(id) {
    if (!existsSync(this.path('accounts', id))) return;
    const v = JSON.parse(readFileSync(this.path('accounts', id), 'utf8'));
    const p = new Player(v.name, v.id, v.password); p.pushDevices = new Map(v.devices); return p;
  }
  save(r) {
    const header = Buffer.from(JSON.stringify({ version: 1, roomId: r.roomId, name: r.roomName, ownerId: r.ownerId,
      maxPlayers: r.maxPlayers, password: r.password, gameData: r.gameData, metaData: r.roomMeta,
      startData: r.startData, players: [...r.gamePlayers], generation: r.hostGeneration, binaryRelay: r.binaryRelay,
      revision: r.revision, updatedAt: r.updatedAt, events: [...r.pushEvents] }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
    writeFileSync(this.path('rooms', r.roomId), Buffer.concat([prefix, header, r.sessionState]));
  }
  load(id) {
    if (!existsSync(this.path('rooms', id))) return;
    const bytes = readFileSync(this.path('rooms', id)), size = bytes.readUInt32BE(0);
    const header = JSON.parse(bytes.subarray(4, 4 + size));
    return { ...header, sessionState: bytes.subarray(4 + size) };
  }
}
module.exports = { SessionStore, Room, Player };
