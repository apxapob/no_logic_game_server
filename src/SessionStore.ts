import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { isUuid, isRecord, validateMessage } from './MessageHandler';
import { Room } from './Room';
import { Player } from './Player';

export interface Notice {
  eventId: string; at: number; to: string[]; title: string; body: string;
  translations?: Record<string, { title: string; body: string }>;
}
export interface Delivery extends Notice { done: string[]; retryAt: number; scheduled: boolean }
interface SavedRoom {
  version: 1; roomId: string; name: string; ownerId: string; maxPlayers: number;
  password: string | null; gameData: unknown; metaData: unknown; startData: unknown;
  players: string[]; generation: number; binaryRelay: boolean; revision: number;
  updatedAt: number; events: string[];
}

/** Game bytes are opaque. Only small notification jobs are retained for sleeping rooms. */
export class SessionStore {
  readonly jobs = new Map<string, Delivery[]>();
  constructor(readonly directory: string, readonly maxBytes: number, private readonly log: (message: string) => void = () => {}) {
    if (!directory) return;
    for (const folder of ['rooms', 'accounts', 'notifications']) mkdirSync(join(directory, folder), { recursive: true, mode: 0o700 });
    for (const file of readdirSync(join(directory, 'notifications'))) {
      if (!file.endsWith('.json') || !isUuid(file.slice(0, -5))) continue;
      try {
        const jobs: unknown = JSON.parse(readFileSync(join(directory, 'notifications', file), 'utf8'));
        if (!Array.isArray(jobs) || !jobs.every(job => isRecord(job) &&
          Array.isArray(job.done) && job.done.every(key => typeof key === 'string') &&
          Number.isSafeInteger(job.retryAt) && Number(job.retryAt) >= 0 && typeof job.scheduled === 'boolean' &&
          validateMessage({ method: 'commitSession', data: { requestId: file.slice(0, -5), scheduled: job, immediate: null } }, 16, 1024)))
          throw new Error('Invalid notification jobs');
        this.jobs.set(file.slice(0, -5), jobs as Delivery[]);
      } catch {
        // Keep the file for diagnosis; one damaged room must not stop healthy rooms.
        this.log(`unreadable notification file skipped: ${file}`);
      }
    }
    this.prune(new Set());
  }
  private path(folder: string, id: string) {
    if (!isUuid(id)) throw new Error('Invalid storage ID');
    return join(this.directory, folder, `${id.toLowerCase()}.${folder === 'rooms' ? 'bin' : 'json'}`);
  }
  private atomic(path: string, data: string | Buffer) {
    writeFileSync(`${path}.tmp`, data, { mode: 0o600, flush: true });
    renameSync(`${path}.tmp`, path);
  }
  saveAccount(p: Player) {
    if (!this.directory) return;
    this.atomic(this.path('accounts', p.playerId), JSON.stringify({ id: p.playerId, password: p.password, name: p.playerName,
      devices: [...p.pushDevices].map(([id, device]) => [id, { ...device, foreground: false }]) }));
  }
  account(id: string): Player | undefined {
    if (!this.directory || !existsSync(this.path('accounts', id))) return;
    const data = JSON.parse(readFileSync(this.path('accounts', id), 'utf8'));
    const p = new Player(data.name, data.id, data.password);
    for (const [key, value] of data.devices) p.pushDevices.set(key, value);
    p.offlineSince = Date.now();
    return p;
  }
  private header(room: Room): SavedRoom {
    return { version: 1, roomId: room.roomId, name: room.roomName, ownerId: room.ownerId,
      maxPlayers: room.maxPlayers, password: room.password, gameData: room.gameData, metaData: room.roomMeta,
      startData: room.startData, players: [...room.gamePlayers], generation: room.hostGeneration,
      binaryRelay: room.binaryRelay, revision: room.revision, updatedAt: room.updatedAt, events: [...room.pushEvents] };
  }
  save(room: Room) {
    const header = Buffer.from(JSON.stringify(this.header(room)));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
    this.atomic(this.path('rooms', room.roomId), Buffer.concat([prefix, header, room.sessionState]));
  }
  load(id: string, body = true): Room | undefined {
    const path = this.path('rooms', id);
    if (!existsSync(path)) return;
    const fd = openSync(path, 'r');
    try {
      const prefix = Buffer.alloc(4);
      if (readSync(fd, prefix, 0, 4, 0) !== 4) throw new Error('Invalid session header');
      const length = prefix.readUInt32BE();
      if (length > 1024 * 1024) throw new Error('Invalid session header size');
      const header = Buffer.alloc(length);
      if (readSync(fd, header, 0, length, 4) !== length) throw new Error('Incomplete session header');
      const data = JSON.parse(header.toString()) as SavedRoom;
      if (data.version !== 1 || data.roomId !== id) throw new Error('Unsupported session');
      const room = new Room(data.name, data.ownerId, data.maxPlayers, data.password, data.gameData, id);
      Object.assign(room, { roomMeta: data.metaData, startData: data.startData, hostGeneration: data.generation,
        binaryRelay: data.binaryRelay, revision: data.revision, updatedAt: data.updatedAt,
        gameStarted: true, fixedRoster: true, hostMigration: true, persistent: true });
      for (const player of data.players) room.gamePlayers.add(player);
      for (const event of data.events) room.pushEvents.add(event);
      if (body) room.sessionState = readFileSync(path).subarray(4 + length);
      return room;
    } finally { closeSync(fd); }
  }
  setJobs(roomId: string, jobs: Delivery[]) {
    const path = this.path('notifications', roomId);
    if (jobs.length) { this.atomic(path, JSON.stringify(jobs)); this.jobs.set(roomId, jobs); }
    else { if (existsSync(path)) unlinkSync(path); this.jobs.delete(roomId); }
  }
  /** Replaces the scheduled event; already queued immediate deliveries keep their retries. */
  commitNotices(room: Room, scheduled: Notice | null, immediate: Notice | null) {
    const previous = this.jobs.get(room.roomId) ?? [];
    const jobs = previous.filter(job => !job.scheduled && job.retryAt !== Number.MAX_SAFE_INTEGER);
    for (const notice of [scheduled, immediate]) {
      if (!notice || room.pushEvents.has(notice.eventId) || jobs.some(job => job.eventId === notice.eventId)) continue;
      jobs.push(previous.find(job => job.eventId === notice.eventId && job.at === notice.at) ?? { ...notice, done: [], retryAt: 0, scheduled: notice === scheduled });
    }
    this.setJobs(room.roomId, jobs);
  }
  prune(active: ReadonlySet<string>): string[] {
    if (!this.directory) return [];
    const entries = readdirSync(join(this.directory, 'rooms')).filter(name => name.endsWith('.bin') && isUuid(name.slice(0, -4))).map(name => {
      const id = name.slice(0, -4); const size = statSync(this.path('rooms', id)).size;
      return { id, size };
    });
    let total = entries.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.maxBytes) return [];
    const candidates = entries.filter(file => !active.has(file.id)).map(file => {
      let at = -Infinity;
      try { at = this.load(file.id, false)!.updatedAt; }
      catch { this.log(`unreadable room file selected for eviction: ${file.id}`); }
      return { ...file, at };
    }).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const removed: string[] = [];
    for (const file of candidates) {
      if (total <= this.maxBytes) break;
      unlinkSync(this.path('rooms', file.id)); this.setJobs(file.id, []);
      total -= file.size; removed.push(file.id);
    }
    return removed;
  }
}
