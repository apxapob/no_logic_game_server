import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import { ServerOptions, ResolvedOptions, resolveOptions } from './config';
import { Player, WSMessage } from './Player';
import { Room } from './Room';
import { isRecord, ProtocolMessage, validateMessage } from './MessageHandler';
export type { ServerOptions } from './config';
interface Connection {
  ws: WebSocket; player: Player | null; created: number; activity: number;
  pingAt: number | null; lastPing: number; rateAt: number; messages: number;
  delayedBytes: number; timers: Set<NodeJS.Timeout>;
}
interface Attempts { since: number; count: number }
interface Transport { created: number; websocket: boolean; ip: string }
const roomIndependentMethods = new Set(['getRooms', 'getPlayers', 'changeName', 'createRoom', 'enterRoom', 'leaveRoom']);
export class Server {
  readonly options: ResolvedOptions;
  private readonly players = new Map<string, Player>();
  private readonly online = new Set<Player>();
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly attempts = new Map<string, Attempts>();
  private readonly transports = new Map<Socket, Transport>();
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private maintenance: NodeJS.Timeout | null = null;
  private state: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' = 'new';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly startupAbort = new AbortController();
  private cancelStartup: (() => void) | null = null;
  constructor(options: ServerOptions = {}) { this.options = resolveOptions(options); }
  private log(text: string): void { try { this.options.logger(text); } catch { /* Logging must not affect lifecycle. */ } }
  address(): AddressInfo | null {
    const address = this.http?.address();
    return typeof address === 'object' && address !== null ? address : null;
  }
  stats(): { accounts: number; online: number; rooms: number; pendingConnections: number } {
    return { accounts: this.players.size, online: this.online.size, rooms: this.rooms.size,
      pendingConnections: [...this.connections.values()].filter(c => c.player === null).length };
  }
  start(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return Promise.reject(new Error('Server is stopped'));
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'new') return Promise.reject(new Error('Server is not startable'));
    this.state = 'starting';
    const http = createServer((req, res) => {
      if (this.state === 'running' && req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...this.stats() }));
      } else { res.writeHead(404); res.end(); }
    });
    this.http = http;
    // HTTP does not own upgraded sockets; track every accepted TCP transport ourselves.
    http.on('connection', socket => {
      const ip = socket.remoteAddress ?? 'unknown';
      if (this.state !== 'running' || this.transports.size >= this.options.maxConnections || !this.admit(ip)) {
        socket.destroy(); return;
      }
      this.transports.set(socket, { created: Date.now(), websocket: false, ip });
      socket.on('error', () => socket.destroy());
      socket.once('close', () => this.transports.delete(socket));
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxPayloadBytes, perMessageDeflate: false });
    this.wss = wss;
    wss.on('error', () => this.log('websocket server error'));
    wss.on('connection', ws => this.connected(ws));
    http.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin;
      const permitted = origin === undefined ? this.options.allowNoOrigin : this.options.allowedOrigins.includes(origin);
      if (this.state !== 'running' || req.url !== '/' || !permitted || !this.transports.has(req.socket)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
        return;
      }
      try {
        wss.handleUpgrade(req, socket, head, ws => {
          const transport = this.transports.get(req.socket);
          if (transport) transport.websocket = true;
          wss.emit('connection', ws, req);
        });
      } catch { socket.destroy(); }
    });
    this.startPromise = new Promise<void>((resolve, reject) => {
      const failure = (error: Error = new Error('Server startup failed')): void => {
        http.removeListener('listening', ready);
        http.removeListener('error', failure);
        this.cancelStartup = null;
        if (this.state !== 'stopping') this.state = 'stopped';
        wss.close();
        reject(error);
      };
      this.cancelStartup = () => failure(new Error('Server stopped during startup'));
      const ready = (): void => {
        http.removeListener('error', failure);
        this.cancelStartup = null;
        if (this.state !== 'starting') { reject(new Error('Server stopped during startup')); return; }
        this.state = 'running';
        this.maintenance = setInterval(() => this.sweep(), this.options.maintenanceIntervalMs);
        this.log('server started'); resolve();
      };
      http.once('error', failure);
      http.once('listening', ready);
      http.on('error', () => this.log('http server error'));
      try { http.listen({ port: this.options.port, host: this.options.host, signal: this.startupAbort.signal }); }
      catch { failure(); }
    });
    return this.startPromise;
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const wasStarting = this.state === 'starting';
    this.state = 'stopping';
    this.cancelStartup?.();
    if (wasStarting) this.startupAbort.abort();
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = null;
    for (const c of this.connections.values()) this.clearDelays(c);
    this.stopPromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      const deadline = setTimeout(() => {
        for (const c of this.connections.values()) c.ws.terminate();
        this.http?.closeAllConnections();
        for (const socket of this.transports.keys()) socket.destroy();
      }, this.options.shutdownTimeoutMs);
      for (const c of this.connections.values()) c.ws.close(1001, 'Server shutting down');
      await Promise.all([
        new Promise<void>(resolve => {
          if (!this.wss) { resolve(); return; }
          this.wss.close(() => resolve());
        }),
        new Promise<void>(resolve => {
          if (!this.http?.listening) { resolve(); return; }
          this.http.close(() => resolve());
          this.http.closeIdleConnections();
        }),
      ]);
      clearTimeout(deadline);
      for (const c of this.connections.values()) { this.clearDelays(c); c.ws.terminate(); }
      // A rejected upgrade may already be detached from HTTP and absent from wss.clients.
      // Destroy and await these transports too, even when HTTP/WS close completed early.
      await new Promise<void>(resolve => {
        if (this.transports.size === 0) { resolve(); return; }
        let remaining = this.transports.size;
        for (const socket of this.transports.keys()) {
          socket.once('close', () => { if (--remaining === 0) resolve(); });
          socket.destroy();
        }
      });
      this.connections.clear(); this.transports.clear(); this.rooms.clear(); this.online.clear(); this.players.clear(); this.attempts.clear();
      this.state = 'stopped'; this.log('server stopped');
    })();
    return this.stopPromise;
  }
  private admit(ip: string): boolean {
    const now = Date.now();
    let attempt = this.attempts.get(ip);
    if (!attempt || now - attempt.since >= 60000) {
      if (!attempt && this.attempts.size >= this.options.maxConnections * 4) {
        for (const [key, value] of this.attempts) if (now - value.since >= 60000) this.attempts.delete(key);
        if (this.attempts.size >= this.options.maxConnections * 4) return false;
      }
      attempt = { since: now, count: 0 }; this.attempts.set(ip, attempt);
    }
    attempt.count = Math.min(attempt.count + 1, this.options.maxConnectionsPerMinute + 1);
    if (attempt.count > this.options.maxConnectionsPerMinute || this.connections.size >= this.options.maxConnections) return false;
    let perIp = 0;
    for (const transport of this.transports.values()) if (transport.ip === ip) perIp++;
    return perIp < this.options.maxConnectionsPerIp;
  }
  private connected(ws: WebSocket): void {
    if (this.state !== 'running') { ws.terminate(); return; }
    const now = Date.now();
    const c: Connection = { ws, player: null,
      created: now, activity: now, pingAt: null, lastPing: now, rateAt: now,
      messages: 0, delayedBytes: 0, timers: new Set() };
    this.connections.set(ws, c);
    ws.on('message', (raw, binary) => this.receive(c, raw, binary));
    ws.on('error', () => { this.log('socket error'); ws.terminate(); });
    ws.on('close', () => {
      this.clearDelays(c); this.connections.delete(ws);
      const p = c.player;
      if (!p || p.ws !== ws) return;
      this.leave(p, true); p.ws = null; p.offlineSince = Date.now(); this.online.delete(p);
    });
  }
  private current(c: Connection): boolean {
    return this.state === 'running' && this.connections.get(c.ws) === c && c.ws.readyState === WebSocket.OPEN && (!c.player || c.player.ws === c.ws);
  }
  private clearDelays(c: Connection): void {
    for (const timer of c.timers) clearTimeout(timer);
    c.timers.clear(); c.delayedBytes = 0;
  }
  private receive(c: Connection, raw: RawData, binary: boolean): void {
    if (!this.current(c)) return;
    const now = Date.now();
    if (now - c.rateAt >= 1000) { c.rateAt = now; c.messages = 0; }
    if (++c.messages > this.options.maxMessagesPerSecond) { c.ws.close(1008, 'Rate limit'); return; }
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
    if (bytes.length > this.options.maxPayloadBytes) { c.ws.close(1009, 'Message too large'); return; }
    c.activity = now;
    if (binary) {
      if (!c.player) { this.error(c, 'invalid_message'); return; }
      const p = c.player;
      this.schedule(c, bytes.length, () => {
        const room = this.activeRoom(p);
        if (room) for (const peer of this.members(room)) if (peer !== p) this.sendBytes(peer, bytes, true);
      });
      return;
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString()); }
    catch { this.error(c, 'invalid_message'); return; }
    if (!validateMessage(value, this.options.maxRoomPlayers, this.options.maxAccounts)) {
      this.error(c, 'invalid_message'); return;
    }
    if (!c.player) {
      if (value.method !== 'authenticate') { this.error(c, 'invalid_message'); return; }
      this.authenticate(c, value.data); return;
    }
    if (value.method === 'authenticate') { this.error(c, 'invalid_message'); return; }
    if (value.method === 'Pong') { this.handle(c.player, value, c); return; }
    this.schedule(c, bytes.length, () => { if (c.player) this.handle(c.player, value, c); },
      !roomIndependentMethods.has(value.method));
  }
  private schedule(c: Connection, size: number, action: () => void, roomScoped = true): void {
    if (this.options.sendDelayMs === 0) { action(); return; }
    if (c.delayedBytes + size > this.options.maxBufferedBytes || c.timers.size >= this.options.maxMessagesPerSecond) {
      c.ws.close(1008, 'Delay limit'); return;
    }
    const p = c.player;
    const version = p?.membershipVersion;
    c.delayedBytes += size;
    const timer = setTimeout(() => {
      c.timers.delete(timer); c.delayedBytes -= size;
      // Global queries and ordered leave/enter commands survive membership changes;
      // room-scoped traffic must never migrate into a later room or session.
      if (this.current(c) && p === c.player && (!roomScoped || p?.membershipVersion === version)) action();
    }, this.options.sendDelayMs);
    c.timers.add(timer);
  }
  private authenticate(c: Connection, data: unknown): void {
    if (!isRecord(data)) return;
    this.expireAccounts(Date.now());
    let p: Player;
    let created = false;
    if (data.playerId !== undefined || data.password !== undefined) {
      const retained = typeof data.playerId === 'string' ? this.players.get(data.playerId) : undefined;
      const provided = Buffer.from(typeof data.password === 'string' ? data.password : '');
      const secret = Buffer.from(retained?.password ?? '');
      if (!retained || secret.length !== provided.length || !timingSafeEqual(secret, provided)) {
        this.sendConnection(c, { method: 'wrongPassword' }); c.ws.close(1008, 'Authentication failed'); return;
      }
      p = retained;
      const old = p.ws;
      p.ws = c.ws;
      if (old && old !== c.ws) {
        const oldConnection = this.connections.get(old);
        if (oldConnection) this.clearDelays(oldConnection);
        old.terminate();
      }
      if (typeof data.name === 'string') p.playerName = data.name;
    } else {
      if (this.players.size >= this.options.maxAccounts) { this.error(c, 'limit_exceeded'); c.ws.close(1008, 'Account limit'); return; }
      p = new Player(typeof data.name === 'string' ? data.name : 'Player');
      this.players.set(p.playerId, p); created = true;
    }
    p.ws = c.ws; p.offlineSince = null; p.rtt = null;
    c.player = p; this.online.add(p);
    if (created) this.sendConnection(c, { method: 'accountCreated', data: { name: p.playerName, playerId: p.playerId, password: p.password } });
    this.sendConnection(c, { method: 'onConnected', data: { online: this.online.size } });
    // Session replacement retains actual membership and its original entry timestamp.
    const activeRoom = this.activeRoom(p);
    if (activeRoom) this.sendConnection(c, { method: 'onRoomEnter', data: this.roomDto(activeRoom) });
  }
  private sendConnection(c: Connection, message: WSMessage): void { this.write(c, JSON.stringify(message), false); }
  private write(c: Connection, bytes: string | Buffer, binary: boolean): void {
    if (!this.current(c)) return;
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
    if (c.ws.bufferedAmount + size > this.options.maxBufferedBytes) { c.ws.close(1008, 'Backpressure'); return; }
    try { c.ws.send(bytes, { binary }, error => { if (error) c.ws.terminate(); }); }
    catch { c.ws.terminate(); }
  }
  private sendBytes(p: Player, bytes: string | Buffer, binary = false): void {
    const c = p.ws ? this.connections.get(p.ws) : undefined;
    if (c) this.write(c, bytes, binary);
  }
  private send(p: Player, message: WSMessage): void { this.sendBytes(p, JSON.stringify(message)); }
  private error(c: Connection, code: string): void { this.sendConnection(c, { method: 'error', data: { code, text: code } }); }
  private playerError(p: Player, code: string): void { this.send(p, { method: 'error', data: { code, text: code } }); }
  private activeRoom(p: Player): Room | undefined {
    const room = p.roomId ? this.rooms.get(p.roomId) : undefined;
    return room?.active.has(p.playerId) ? room : undefined;
  }
  private members(room: Room): Player[] {
    const members: Player[] = [];
    for (const id of room.active) {
      const p = this.players.get(id);
      if (p?.ws && p.roomId === room.roomId) members.push(p);
    }
    return members;
  }
  private broadcast(room: Room, message: WSMessage, except?: string, targets?: Set<string>): void {
    const json = JSON.stringify(message);
    for (const p of this.members(room)) if (p.playerId !== except && (!targets || targets.has(p.playerId))) this.sendBytes(p, json);
  }
  private lobby(message: WSMessage): void {
    const json = JSON.stringify(message);
    for (const p of this.online) if (p.roomId === null) this.sendBytes(p, json);
  }
  private roomDto(room: Room) { return room.toNetObject(this.players.get(room.ownerId)?.rtt ?? null); }
  private enter(p: Player, id: string, password: unknown): void {
    if (p.roomId) { this.playerError(p, p.roomId === id ? 'already_in_room' : 'in_other_room'); return; }
    const room = this.rooms.get(id);
    if (!room) { this.playerError(p, 'no_room'); return; }
    if (room.gameStarted && !room.reservations.has(p.playerId)) { this.playerError(p, 'game_started_without_you'); return; }
    if (!room.gameStarted && (password ?? null) !== room.password) { this.playerError(p, 'wrong_password'); return; }
    if (room.active.size >= room.maxPlayers) { this.playerError(p, 'full_room'); return; }
    p.roomId = id; p.roomEntryTimestamp = Date.now(); p.membershipVersion++;
    room.active.add(p.playerId); room.reservations.delete(p.playerId);
    this.broadcast(room, { method: 'playerEnter', data: p.toNetObject() }, p.playerId);
    this.send(p, { method: 'onRoomEnter', data: this.roomDto(room) });
  }
  private leave(p: Player, disconnected: boolean): void {
    const room = this.activeRoom(p);
    p.roomId = null; p.roomEntryTimestamp = null; p.membershipVersion++;
    if (!disconnected) for (const r of this.rooms.values()) r.reservations.delete(p.playerId);
    if (!room) return;
    room.active.delete(p.playerId);
    if (disconnected && room.gameStarted) room.reservations.add(p.playerId);
    else room.reservations.delete(p.playerId);
    this.broadcast(room, { method: disconnected ? 'playerDisconnected' : 'playerLeft', data: p.playerId });
    if (room.active.size === 0) {
      room.reservations.clear(); this.rooms.delete(room.roomId);
      this.lobby({ method: 'roomDeleted', data: room.roomId }); return;
    }
    if (room.ownerId === p.playerId) {
      const nextOwner = room.active.values().next().value;
      if (nextOwner !== undefined) {
        room.ownerId = nextOwner;
        this.broadcast(room, { method: 'newRoomOwner', data: room.ownerId });
      }
    }
  }
  private handle(p: Player, message: ProtocolMessage, c: Connection): void {
    const d = message.data;
    const record = isRecord(d) ? d : {};
    if (message.method === 'Pong') {
      if (typeof d === 'number' && c.pingAt !== null && d === c.pingAt) {
        const elapsed = Date.now() - c.pingAt;
        if (Number.isFinite(elapsed) && elapsed >= 0) p.rtt = elapsed;
        c.pingAt = null;
      }
      return;
    }
    switch (message.method) {
      case 'getRooms': this.send(p, { method: 'onGetRooms', data: [...this.rooms.values()].filter(r => !r.gameStarted || r.active.has(p.playerId) || r.reservations.has(p.playerId)).map(r => this.roomDto(r)) }); return;
      case 'getPlayers': {
        const selected = Array.isArray(d) ? d.flatMap(id => {
          const player = typeof id === 'string' ? this.players.get(id) : undefined;
          return player ? [player] : [];
        }) : [...this.online];
        const dto = selected.map(player => player.toNetObject()).sort((a, b) => {
          if (a.roomEntryTimestamp === null && b.roomEntryTimestamp !== null) return 1;
          if (a.roomEntryTimestamp !== null && b.roomEntryTimestamp === null) return -1;
          return (a.roomEntryTimestamp ?? 0) - (b.roomEntryTimestamp ?? 0) || a.playerId.localeCompare(b.playerId);
        });
        this.send(p, { method: 'onGetPlayers', data: dto }); return;
      }
      case 'changeName': {
        if (typeof d === 'string') p.playerName = d;
        const room = this.activeRoom(p);
        if (room) this.broadcast(room, { method: 'nameChanged', data: { name: p.playerName, playerId: p.playerId } }); return;
      }
      case 'enterRoom': if (typeof record.roomId === 'string') this.enter(p, record.roomId, record.password); return;
      case 'leaveRoom': this.leave(p, false); return;
      case 'createRoom': {
        if (p.roomId) { this.playerError(p, 'in_other_room'); return; }
        if (this.rooms.size >= this.options.maxRooms) { this.playerError(p, 'limit_exceeded'); return; }
        if (typeof record.name !== 'string' || typeof record.maxPlayers !== 'number') return;
        const room = new Room(record.name, p.playerId, record.maxPlayers, typeof record.password === 'string' ? record.password : null, record.gameData ?? null);
        this.rooms.set(room.roomId, room); this.enter(p, room.roomId, room.password);
        this.lobby({ method: 'roomCreated', data: this.roomDto(room) }); return;
      }
    }
    const room = this.activeRoom(p);
    if (!room) { this.playerError(p, 'no_room'); return; }
    const targets = Array.isArray(record.to) ? new Set(record.to.filter((id): id is string => typeof id === 'string')) : undefined;
    switch (message.method) {
      case 'sendChatMsg': this.broadcast(room, { method: 'chatMsg', data: { text: d, from: p.playerId } }); break;
      case 'sendToRoom': this.broadcast(room, { method: 'messageFromPlayer', data: { from: p.playerId, msg: d } }, p.playerId); break;
      case 'sendTo': this.broadcast(room, { method: 'messageFromPlayer', data: { from: p.playerId, msg: record.msg } }, undefined, targets); break;
      case 'requestGameState': {
        const owner = this.players.get(room.ownerId);
        if (owner && this.activeRoom(owner) === room) this.send(owner, { method: 'gameStateRequested', data: p.toNetObject() }); break;
      }
      case 'startGame': case 'shareGameState': case 'setRoomMeta': {
        if (room.ownerId !== p.playerId) { this.playerError(p, 'not_room_owner'); return; }
        if (message.method === 'startGame') {
          if (room.gameStarted) { this.playerError(p, 'already_started'); return; }
          room.gameStarted = true; this.broadcast(room, { method: 'gameStarted', data: d }); this.lobby({ method: 'roomBlock', data: room.roomId });
        } else if (message.method === 'shareGameState') {
          this.broadcast(room, { method: 'newGameState', data: record.gamestate }, targets ? undefined : p.playerId, targets);
        } else { room.roomMeta = d; this.broadcast(room, { method: 'onSetRoomMeta', data: d }); }
        break;
      }
    }
  }
  private expireAccounts(now: number): void {
    for (const [id, p] of this.players) if (!p.ws && p.offlineSince !== null && now - p.offlineSince >= this.options.accountTtlMs) {
      for (const room of this.rooms.values()) room.reservations.delete(id);
      this.players.delete(id);
    }
  }
  private sweep(): void {
    if (this.state !== 'running') return;
    const now = Date.now();
    // Bound pre-upgrade/partial HTTP transports without introducing another timer.
    for (const [socket, transport] of this.transports) {
      if (!transport.websocket && now - transport.created >= this.options.authTimeoutMs) socket.destroy();
    }
    let heartbeat = false;
    for (const c of this.connections.values()) {
      if (!this.current(c)) continue;
      if (!c.player) {
        if (now - c.created >= this.options.authTimeoutMs) c.ws.terminate();
        continue;
      }
      if (now - c.activity >= this.options.idleTimeoutMs || (c.pingAt !== null && now - c.pingAt >= this.options.idleTimeoutMs)) { c.ws.terminate(); continue; }
      if (now - c.lastPing >= this.options.heartbeatIntervalMs) {
        c.lastPing = now; heartbeat = true;
        if (c.pingAt === null) { c.pingAt = now; this.sendConnection(c, { method: 'Ping', data: now }); }
      }
    }
    if (heartbeat) for (const room of this.rooms.values()) {
      const rtt: Record<string, number> = {};
      for (const p of this.members(room)) if (p.rtt !== null) rtt[p.playerId] = p.rtt;
      this.broadcast(room, { method: 'RoomRTT', data: rtt });
    }
    this.expireAccounts(now);
    for (const [ip, attempt] of this.attempts) if (now - attempt.since >= 60000) this.attempts.delete(ip);
  }
}
