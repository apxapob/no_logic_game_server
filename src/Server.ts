import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ServerOptions, ResolvedOptions, resolveOptions } from './config';
import { Player, WSMessage } from './Player';
import { Room } from './Room';
import { isRecord, ProtocolMessage, validateMessage } from './MessageHandler';
import { redact } from './Logging';
import { binaryFrom, binaryTarget } from './BinaryRelay';
import { SessionStore, Notice } from './SessionStore';
export type { ServerOptions } from './config';
interface Connection {
  id: string; ip: string;
  ws: WebSocket; player: Player | null; created: number; activity: number;
  pingAt: number | null; lastPing: number; rateAt: number; messages: number;
  delayedBytes: number; timers: Set<NodeJS.Timeout>;
}
interface Attempts { since: number; count: number }
interface Transport { id: string; created: number; websocket: boolean; ip: string }
const roomIndependentMethods = new Set(['getRooms', 'getSavedRooms', 'getPlayers', 'changeName', 'createRoom', 'enterRoom', 'leaveRoom', 'setPushDevice']);
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
  private pushesInFlight = 0;
  private cancelStartup: (() => void) | null = null;
  private readonly store: SessionStore;
  private delivering = false;
  constructor(options: ServerOptions = {}) {
    this.options = resolveOptions(options);
    this.store = new SessionStore(this.options.sessionDirectory, this.options.sessionMaxBytes, text => this.log(text));
  }
  private log(text: string): void {
    try { this.options.telemetry(text, {}); } catch { /* Diagnostics cannot affect lifecycle. */ }
    try { this.options.logger(this.options.verboseLogs ? JSON.stringify({ time: new Date().toISOString(), event: text }) : text); }
    catch { /* Logging must not affect lifecycle. */ }
  }
  private trace(event: string, details: Record<string, unknown> = {}, c?: Connection): void {
    try { this.options.telemetry(event, details); } catch { /* Diagnostics cannot affect protocol handling. */ }
    if (!this.options.verboseLogs) return;
    try {
      this.options.logger(JSON.stringify({ time: new Date().toISOString(), event,
        ...(c ? { connectionId: c.id, ip: c.ip, playerId: c.player?.playerId ?? null, roomId: c.player?.roomId ?? null } : {}),
        ...details }));
    } catch { /* A diagnostic sink must not interrupt message handling. */ }
  }
  private frame(c: Connection, direction: 'in' | 'out', type: 'text' | 'binary' | 'ping' | 'pong', bytes: string | Buffer): void {
    if (!this.options.verboseLogs) return;
    const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    let payload: unknown;
    if (type === 'text') {
      try { payload = redact(JSON.parse(buffer.toString())); }
      catch { payload = '[omitted: invalid JSON]'; }
    } else payload = buffer.toString('base64');
    this.trace('message', { direction, type, bytes: buffer.length, encoding: type === 'text' ? 'json' : 'base64', payload }, c);
  }
  private terminate(c: Connection, reason: string): void {
    this.trace('connection.terminate', { reason }, c); c.ws.terminate();
  }
  private closeConnection(c: Connection, code: number, reason: string): void {
    this.trace('connection.close_requested', { code, reason }, c); c.ws.close(code, reason);
  }
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
      this.trace('http.request', { connectionId: this.transports.get(req.socket)?.id,
        method: req.method, route: req.url === '/healthz' ? '/healthz' : 'other',
        status: this.state === 'running' && req.method === 'GET' && req.url === '/healthz' ? 200 : 404 });
      if (this.state === 'running' && req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...this.stats() }));
      } else { res.writeHead(404); res.end(); }
    });
    this.http = http;
    // HTTP does not own upgraded sockets; track every accepted TCP transport ourselves.
    http.on('connection', socket => {
      const ip = socket.remoteAddress ?? 'unknown';
      const id = randomUUID();
      if (this.state !== 'running' || this.transports.size >= this.options.maxConnections || !this.admit(ip)) {
        this.trace('transport.rejected', { connectionId: id, ip, reason: this.state !== 'running' ? 'server_not_running' : 'connection_limit' });
        socket.destroy(); return;
      }
      this.transports.set(socket, { id, created: Date.now(), websocket: false, ip });
      this.trace('transport.connected', { connectionId: id, ip, port: socket.remotePort });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        this.trace('transport.error', { connectionId: id, code: error.code }); socket.destroy();
      });
      socket.once('close', hadError => {
        this.trace('transport.disconnected', { connectionId: id, ip, hadError }); this.transports.delete(socket);
      });
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.options.maxPayloadBytes, perMessageDeflate: false, autoPong: false });
    this.wss = wss;
    wss.on('error', () => this.log('websocket server error'));
    wss.on('connection', (ws, req) => this.connected(ws, this.transports.get(req.socket)));
    http.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin;
      const permitted = origin === undefined ? this.options.allowNoOrigin : this.options.allowedOrigins.includes(origin);
      if (this.state !== 'running' || req.url !== '/' || !permitted || !this.transports.has(req.socket)) {
        this.trace('upgrade.rejected', { connectionId: this.transports.get(req.socket)?.id,
          reason: this.state !== 'running' ? 'server_not_running' : req.url !== '/' ? 'invalid_path' : !permitted ? 'origin_not_allowed' : 'unknown_transport' });
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
        return;
      }
      try {
        wss.handleUpgrade(req, socket, head, ws => {
          const transport = this.transports.get(req.socket);
          if (transport) transport.websocket = true;
          wss.emit('connection', ws, req);
        });
      } catch { this.trace('upgrade.error', { connectionId: this.transports.get(req.socket)?.id }); socket.destroy(); }
    });
    this.startPromise = new Promise<void>((resolve, reject) => {
      const failure = (error: Error = new Error('Server startup failed')): void => {
        this.trace('server.start_failed', { code: (error as NodeJS.ErrnoException).code });
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
        this.log('server started'); this.trace('server.listening', { address: this.address() }); resolve();
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
    this.trace('server.stopping', this.stats());
    this.cancelStartup?.();
    if (wasStarting) this.startupAbort.abort();
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = null;
    for (const c of this.connections.values()) this.clearDelays(c);
    this.stopPromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      const deadline = setTimeout(() => {
        for (const c of this.connections.values()) this.terminate(c, 'shutdown_timeout');
        this.http?.closeAllConnections();
        for (const socket of this.transports.keys()) socket.destroy();
      }, this.options.shutdownTimeoutMs);
      for (const c of this.connections.values()) this.closeConnection(c, 1001, 'Server shutting down');
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
      for (const room of this.rooms.values()) if (room.persistent) this.store.save(room);
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
  private connected(ws: WebSocket, transport?: Transport): void {
    if (this.state !== 'running') { ws.terminate(); return; }
    const now = Date.now();
    const c: Connection = { ws, player: null, id: transport?.id ?? randomUUID(), ip: transport?.ip ?? 'unknown',
      created: now, activity: now, pingAt: null, lastPing: now, rateAt: now,
      messages: 0, delayedBytes: 0, timers: new Set() };
    this.connections.set(ws, c);
    this.trace('connection.connected', {}, c);
    ws.on('message', (raw, binary) => {
      try { this.receive(c, raw, binary); }
      catch { this.log('storage operation failed'); this.error(c, 'storage_error'); }
    });
    ws.on('ping', data => this.control(c, data, true));
    ws.on('pong', data => this.control(c, data, false));
    ws.on('error', (error: NodeJS.ErrnoException) => {
      this.log('socket error'); this.trace('connection.error', { code: error.code }, c); this.terminate(c, 'socket_error');
    });
    ws.on('close', (code, reason) => {
      this.trace('connection.disconnected', { code, reason: reason.toString(), durationMs: Date.now() - c.created }, c);
      this.connections.delete(ws); this.releasePlayer(c);
    });
  }
  private releasePlayer(c: Connection): void {
    this.clearDelays(c);
    const p = c.player;
    // A closing transport must not retain membership. Fence repeated cleanup
    // and late close events from a socket that has already been replaced.
    if (!p || p.ws !== c.ws) return;
    p.ws = null; p.offlineSince = Date.now(); this.online.delete(p);
    this.leave(p, true);
  }
  private current(c: Connection): boolean {
    return this.state === 'running' && this.connections.get(c.ws) === c && c.ws.readyState === WebSocket.OPEN && (!c.player || c.player.ws === c.ws);
  }
  private clearDelays(c: Connection): void {
    for (const timer of c.timers) clearTimeout(timer);
    c.timers.clear(); c.delayedBytes = 0;
  }
  private allowInbound(c: Connection): boolean {
    if (!this.current(c)) return false;
    const now = Date.now();
    if (now - c.rateAt >= 1000) { c.rateAt = now; c.messages = 0; }
    // Termination cannot itself enqueue a close frame behind a saturated socket.
    if (++c.messages > this.options.maxMessagesPerSecond) { this.terminate(c, 'message_rate_limit'); return false; }
    c.activity = now;
    return true;
  }
  private control(c: Connection, bytes: Buffer, reply: boolean): void {
    this.frame(c, 'in', reply ? 'ping' : 'pong', bytes);
    if (!this.allowInbound(c) || !reply) return;
    // RFC control replies bypass send(), so account for their two-byte header here.
    if (!this.reserveOutput(c, bytes.length + 2)) return;
    try {
      c.ws.pong(bytes, false, error => { if (error) this.terminate(c, 'pong_send_error'); });
      this.frame(c, 'out', 'pong', bytes);
    } catch { this.terminate(c, 'pong_send_error'); }
  }
  private receive(c: Connection, raw: RawData, binary: boolean): void {
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
    this.frame(c, 'in', binary ? 'binary' : 'text', bytes);
    if (!this.allowInbound(c)) return;
    if (bytes.length > this.options.maxPayloadBytes) { this.closeConnection(c, 1009, 'Message too large'); return; }
    if (binary) {
      if (!c.player) { this.error(c, 'invalid_message'); return; }
      if (!this.messageFits(bytes.length)) { this.error(c, 'payload_too_large'); return; }
      const p = c.player;
      this.schedule(c, bytes.length, () => {
        const room = this.activeRoom(p);
        if (!room) return;
        if (bytes[0] === 2 && room.persistent) {
          this.uploadChunk(p, room, bytes); return;
        }
        if (room.binaryRelay) {
          const target = binaryTarget(bytes);
          if (target === undefined) { this.error(c, 'invalid_message'); return; }
          const relayed = binaryFrom(bytes, p.playerId);
          for (const peer of this.members(room))
            if (peer !== p && (target === null || peer.playerId === target)) this.sendBytes(peer, relayed, true);
        } else {
          for (const peer of this.members(room)) if (peer !== p) this.sendBytes(peer, bytes, true);
        }
      });
      return;
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString()); }
    catch { this.error(c, 'invalid_message'); return; }
    if (!validateMessage(value, this.options.maxRoomPlayers, this.options.maxAccounts)) {
      this.error(c, 'invalid_message'); return;
    }
    // Short number literals can expand substantially after JSON.parse/stringify.
    const canonicalBytes = Buffer.byteLength(JSON.stringify(value));
    if (canonicalBytes > this.options.maxPayloadBytes) { this.error(c, 'payload_too_large'); return; }
    if (!c.player) {
      if (value.method !== 'authenticate') { this.error(c, 'invalid_message'); return; }
      this.authenticate(c, value.data); return;
    }
    if (value.method === 'authenticate') { this.error(c, 'invalid_message'); return; }
    if (value.method === 'Pong') { this.handle(c.player, value, c); return; }
    this.schedule(c, canonicalBytes, () => { if (c.player) this.handle(c.player, value, c); },
      !roomIndependentMethods.has(value.method));
  }
  private schedule(c: Connection, size: number, action: () => void, roomScoped = true): void {
    if (this.options.sendDelayMs === 0) { action(); return; }
    if (c.delayedBytes + size > this.options.maxBufferedBytes || c.timers.size >= this.options.maxMessagesPerSecond) {
      this.closeConnection(c, 1008, 'Delay limit'); return;
    }
    const p = c.player;
    const version = p?.membershipVersion;
    c.delayedBytes += size;
    this.trace('message.delayed', { bytes: size, delayMs: this.options.sendDelayMs, roomScoped }, c);
    const timer = setTimeout(() => {
      c.timers.delete(timer); c.delayedBytes -= size;
      // Global queries and ordered leave/enter commands survive membership changes;
      // room-scoped traffic must never migrate into a later room or session.
      if (this.current(c) && p === c.player && (!roomScoped || p?.membershipVersion === version)) {
        try { action(); } catch { this.log('storage operation failed'); this.error(c, 'storage_error'); }
      }
      else this.trace('message.discarded', { reason: 'session_or_room_changed', bytes: size }, c);
    }, this.options.sendDelayMs);
    c.timers.add(timer);
  }
  private authenticate(c: Connection, data: unknown): void {
    if (!isRecord(data)) return;
    this.expireAccounts(Date.now());
    let p: Player;
    let created = false;
    if (data.playerId !== undefined || data.password !== undefined) {
      const retained = typeof data.playerId === 'string' ? this.players.get(data.playerId) ?? this.store.account(data.playerId) : undefined;
      const provided = Buffer.from(typeof data.password === 'string' ? data.password : '');
      const secret = Buffer.from(retained?.password ?? '');
      if (!retained || secret.length !== provided.length || !timingSafeEqual(secret, provided)) {
        this.trace('authentication.failed', {}, c);
        this.sendConnection(c, { method: 'wrongPassword' }); this.closeConnection(c, 1008, 'Authentication failed'); return;
      }
      p = retained;
      this.players.set(p.playerId, p);
      // A fresh client has no world even if the old socket has not timed out yet.
      // Let its fixed-roster game pause and require a normal authenticated re-entry.
      const previousRoom = this.activeRoom(p);
      if (previousRoom?.gameStarted && previousRoom.fixedRoster) this.leave(p, true);
      const old = p.ws;
      p.ws = c.ws;
      if (old && old !== c.ws) {
        const oldConnection = this.connections.get(old);
        if (oldConnection) { this.clearDelays(oldConnection); this.terminate(oldConnection, 'session_replaced'); }
        else old.terminate();
      }
      if (typeof data.name === 'string') p.playerName = data.name;
    } else {
      if (this.players.size >= this.options.maxAccounts) { this.error(c, 'limit_exceeded'); this.closeConnection(c, 1008, 'Account limit'); return; }
      p = new Player(typeof data.name === 'string' ? data.name : 'Player');
      this.players.set(p.playerId, p); created = true;
    }
    p.ws = c.ws; p.offlineSince = null; p.rtt = null;
    c.player = p; this.online.add(p);
    this.store.saveAccount(p);
    this.trace('authentication.succeeded', { created }, c);
    if (created) this.sendConnection(c, { method: 'accountCreated', data: { name: p.playerName, playerId: p.playerId, password: p.password } });
    this.sendConnection(c, { method: 'onConnected', data: { online: this.online.size,
      ...(this.options.sessionDirectory ? { persistentSessions: true } : {}),
      ...(this.options.pushSender ? { pushNotifications: true } : {}) } });
    // Session replacement retains actual membership and its original entry timestamp.
    const activeRoom = this.activeRoom(p);
    if (activeRoom) this.sendConnection(c, { method: 'onRoomEnter', data: this.roomDto(activeRoom) });
  }
  private messageFits(size: number): boolean {
    // Ten bytes cover the largest unmasked data-frame header.
    return size <= this.options.maxPayloadBytes && size + 10 <= this.options.maxBufferedBytes;
  }
  private encode(message: WSMessage): string | null {
    const json = JSON.stringify(message);
    return this.messageFits(Buffer.byteLength(json)) ? json : null;
  }
  private prepareRelay(p: Player, message: WSMessage): string | null {
    const json = this.encode(message);
    if (json === null) this.playerError(p, 'payload_too_large');
    return json;
  }
  private sendConnection(c: Connection, message: WSMessage): void {
    const json = this.encode(message) ?? this.encode({ method: 'error', data: { code: 'response_too_large', text: 'response_too_large' } });
    if (json !== null) this.write(c, json, false);
  }
  private reserveOutput(c: Connection, size: number): boolean {
    if (!this.current(c)) return false;
    if (c.ws.bufferedAmount + size > this.options.maxBufferedBytes) { this.terminate(c, 'output_buffer_limit'); return false; }
    return true;
  }
  private write(c: Connection, bytes: string | Buffer, binary: boolean): void {
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
    // An oversized server message is not evidence that its recipient is slow.
    if (!this.messageFits(size) || !this.reserveOutput(c, size + 10)) {
      this.trace('message.not_sent', { bytes: size, reason: !this.messageFits(size) ? 'payload_too_large' : 'connection_unavailable' }, c); return;
    }
    try {
      c.ws.send(bytes, { binary }, error => { if (error) this.terminate(c, 'send_error'); });
      this.frame(c, 'out', binary ? 'binary' : 'text', bytes);
    } catch { this.terminate(c, 'send_error'); }
  }
  private sendBytes(p: Player, bytes: string | Buffer, binary = false): void {
    const c = p.ws ? this.connections.get(p.ws) : undefined;
    if (c) this.write(c, bytes, binary);
  }
  private send(p: Player, message: WSMessage): void {
    const c = p.ws ? this.connections.get(p.ws) : undefined;
    if (c) this.sendConnection(c, message);
  }
  private error(c: Connection, code: string): void {
    this.trace('protocol.error', { code }, c); this.sendConnection(c, { method: 'error', data: { code, text: code } });
  }
  private playerError(p: Player, code: string): void {
    this.trace('protocol.error', { code, playerId: p.playerId, roomId: p.roomId }); this.send(p, { method: 'error', data: { code, text: code } });
  }
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
  private broadcastJson(room: Room, json: string, except?: string, targets?: Set<string>): void {
    for (const p of this.members(room)) if (p.playerId !== except && (!targets || targets.has(p.playerId))) this.sendBytes(p, json);
  }
  private broadcast(room: Room, message: WSMessage, except?: string): void {
    const json = this.encode(message);
    if (json !== null) this.broadcastJson(room, json, except);
  }
  private lobby(message: WSMessage): void {
    const json = this.encode(message);
    if (json !== null) for (const p of this.online) if (p.roomId === null) this.sendBytes(p, json);
  }
  private roomDto(room: Room) { return room.toNetObject(this.players.get(room.ownerId)?.rtt ?? null); }
  private roomFits(room: Room, metaData: unknown = room.roomMeta, maxPlayers = room.maxPlayers,
    hasPassword = room.password !== null, name = room.roomName): boolean {
    // Reserve growth from future joins, RTT values and the pagination envelope.
    // Otherwise an accepted room could become unreadable merely by filling up.
    // Reject impossible capacities arithmetically before allocating placeholder IDs.
    if (!this.messageFits(maxPlayers * (room.ownerId.length + 3) + 1)) return false;
    const dto = { ...this.roomDto(room), metaData, maxPlayers, hasPassword, name, gameStarted: false,
      players: Array<string>(maxPlayers).fill(room.ownerId), rtt: Number.MAX_SAFE_INTEGER };
    return this.encode({ method: 'onGetRooms', data: [dto], nextCursor: room.roomId }) !== null;
  }
  private roomPage(p: Player, after?: string): void {
    const rooms = [...this.rooms.values()]
      .filter(r => (!after || r.roomId > after) && (!r.gameStarted || r.active.has(p.playerId) || r.canRejoin(p.playerId)))
      .sort((a, b) => a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0);
    const data: ReturnType<Server['roomDto']>[] = [];
    let nextCursor: string | null = null;
    for (let i = 0; i < rooms.length; i++) {
      const dto = this.roomDto(rooms[i]);
      const cursor = i + 1 < rooms.length ? dto.roomId : null;
      if (this.encode({ method: 'onGetRooms', data: [...data, dto], nextCursor: cursor }) === null) {
        if (data.length === 0) { this.playerError(p, 'response_too_large'); return; }
        break;
      }
      data.push(dto); nextCursor = cursor;
    }
    this.send(p, { method: 'onGetRooms', data, nextCursor });
  }
  private enter(p: Player, id: string, password: unknown): void {
    if (p.roomId) { this.playerError(p, p.roomId === id ? 'already_in_room' : 'in_other_room'); return; }
    const room = this.rooms.get(id) ?? (this.options.sessionDirectory ? this.store.load(id) : undefined);
    if (!room) { this.playerError(p, 'no_room'); return; }
    if (!room.gameStarted && room.joinClosed) { this.playerError(p, 'room_closed'); return; }
    if (room.gameStarted && !room.canRejoin(p.playerId)) {
      this.playerError(p, 'game_started_without_you'); return;
    }
    if (!room.gameStarted && (password ?? null) !== room.password) { this.playerError(p, 'wrong_password'); return; }
    if (room.active.size >= room.maxPlayers) { this.playerError(p, 'full_room'); return; }
    if (room.persistent && room.active.size === 0) {
      room.ownerId = p.playerId; room.hostGeneration++; room.upload = null;
    }
    this.rooms.set(id, room);
    p.roomId = id; p.roomEntryTimestamp = Date.now(); p.membershipVersion++;
    room.active.add(p.playerId); room.reservations.delete(p.playerId);
    this.trace('room.entered', { roomId: room.roomId, playerId: p.playerId });
    this.broadcast(room, { method: 'playerEnter', data: p.toNetObject() }, p.playerId);
    this.send(p, { method: 'onRoomEnter', data: this.roomDto(room) });
  }
  private leave(p: Player, disconnected: boolean): void {
    const room = this.activeRoom(p);
    p.roomId = null; p.roomEntryTimestamp = null; p.membershipVersion++;
    if (!disconnected) for (const r of this.rooms.values()) r.reservations.delete(p.playerId);
    if (!room) return;
    this.trace('room.left', { roomId: room.roomId, playerId: p.playerId, disconnected });
    room.active.delete(p.playerId);
    if (room.upload?.owner === p.playerId) room.upload = null;
    if (disconnected && room.gameStarted) room.reservations.add(p.playerId);
    else room.reservations.delete(p.playerId);
    this.broadcast(room, { method: disconnected ? 'playerDisconnected' : 'playerLeft', data: p.playerId });
    // Reconnectable games keep their authoritative host. Losing it ends the match for everyone.
    if (room.gameStarted && room.fixedRoster && !room.hostMigration && room.ownerId === p.playerId) {
      for (const member of this.members(room)) {
        member.roomId = null; member.roomEntryTimestamp = null; member.membershipVersion++;
      }
      room.active.clear();
    }
    if (room.active.size === 0) {
      if (room.persistent) {
        this.sleepRoom(room); return;
      }
      room.reservations.clear(); this.rooms.delete(room.roomId);
      this.trace('room.deleted', { roomId: room.roomId });
      this.lobby({ method: 'roomDeleted', data: room.roomId }); return;
    }
    if (room.ownerId === p.playerId) {
      const nextOwner = room.active.values().next().value;
      if (nextOwner !== undefined) {
        room.ownerId = nextOwner;
        room.hostGeneration++;
        this.trace('room.owner_changed', { roomId: room.roomId, ownerId: nextOwner });
        this.broadcast(room, { method: 'newRoomOwner', data: room.hostMigration
          ? { playerId: room.ownerId, generation: room.hostGeneration } : room.ownerId });
      }
    }
    if (room.gameStarted && room.fixedRoster) {
      // Started rooms are private to their original participants, including after explicit leave.
      for (const id of room.gamePlayers) {
        const member = this.players.get(id);
        if (member?.roomId === null) this.send(member, { method: 'roomCreated', data: this.roomDto(room) });
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
      case 'getSavedRooms': {
        for (const id of record.ids as string[]) {
          const saved = this.rooms.get(id) ?? (this.options.sessionDirectory ? this.store.load(id, false) : undefined);
          this.send(p, { method: 'savedRoom', data: { roomId: id,
            room: saved?.persistent && saved.gamePlayers.has(p.playerId) ? this.roomDto(saved) : null } });
        }
        return;
      }
      case 'getRooms': this.roomPage(p, typeof record.after === 'string' ? record.after.toLowerCase() : undefined); return;
      case 'getPlayers': {
        const selected = Array.isArray(d) ? d.flatMap(id => {
          const player = typeof id === 'string' ? this.players.get(id) ?? this.store.account(id) : undefined;
          return player ? [player] : [];
        }) : [...this.online];
        const dto = selected.map(player => player.toNetObject()).sort((a, b) => {
          if (a.roomEntryTimestamp === null && b.roomEntryTimestamp !== null) return 1;
          if (a.roomEntryTimestamp !== null && b.roomEntryTimestamp === null) return -1;
          return (a.roomEntryTimestamp ?? 0) - (b.roomEntryTimestamp ?? 0) || a.playerId.localeCompare(b.playerId);
        });
        this.send(p, { method: 'onGetPlayers', data: dto }); return;
      }
      case 'setPushDevice': {
        if (!this.options.pushSender) { this.playerError(p, 'push_unavailable'); return; }
        const deviceId = record.deviceId as string;
        const token = record.token as string | null;
        if (token === null) p.pushDevices.delete(deviceId);
        else {
          // A refreshed login owns this installation; no duplicate delivery to old accounts.
          for (const account of this.players.values()) {
            for (const [id, device] of account.pushDevices) {
              if (device.token === token && (account !== p || id !== deviceId)) account.pushDevices.delete(id);
            }
          }
          if (!p.pushDevices.has(deviceId) && p.pushDevices.size >= 4) p.pushDevices.delete(p.pushDevices.keys().next().value!);
          p.pushDevices.set(deviceId, { token, foreground: record.foreground === true,
            language: typeof record.language === 'string' ? record.language : 'en' });
        }
        this.store.saveAccount(p);
        this.send(p, { method: 'pushDeviceUpdated' }); return;
      }
      case 'changeName': {
        if (typeof d === 'string') p.playerName = d;
        this.store.saveAccount(p);
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
        room.binaryRelay = record.binaryRelay === true;
        if (!this.roomFits(room)) { this.playerError(p, 'payload_too_large'); return; }
        this.rooms.set(room.roomId, room);
        this.trace('room.created', { roomId: room.roomId, ownerId: p.playerId });
        this.enter(p, room.roomId, room.password);
        this.lobby({ method: 'roomCreated', data: this.roomDto(room) }); return;
      }
    }
    const room = this.activeRoom(p);
    if (!room) { this.playerError(p, 'no_room'); return; }
    if (['getSession', 'getSessionChunk', 'beginSession', 'commitSession'].includes(message.method)) {
      this.sessionMessage(p, room, message.method, record); return;
    }
    const targets = Array.isArray(record.to) ? new Set(record.to.filter((id): id is string => typeof id === 'string')) : undefined;
    switch (message.method) {
      case 'notifyPlayers': {
        if (!this.options.pushSender) { this.playerError(p, 'push_unavailable'); return; }
        if (room.ownerId !== p.playerId) { this.playerError(p, 'not_room_owner'); return; }
        if (!room.gameStarted || !room.fixedRoster || !targets ||
          [...targets].some(id => !room.gamePlayers.has(id))) { this.playerError(p, 'invalid_message'); return; }
        const eventId = record.eventId as string;
        if (room.pushEvents.has(eventId)) return;
        const now = Date.now();
        if (now - room.lastPushAt < 30000 || this.pushesInFlight >= 32) { this.playerError(p, 'push_rate_limited'); return; }
        room.lastPushAt = now;
        room.pushEvents.add(eventId);
        if (room.pushEvents.size > 128) room.pushEvents.delete(room.pushEvents.values().next().value!);
        const texts = isRecord(record.translations) ? record.translations : {};
        for (const id of targets) {
          if (id === p.playerId) continue;
          const target = this.players.get(id);
          if (!target) continue;
          for (const [deviceId, device] of target.pushDevices) {
            if ((target.ws?.readyState === WebSocket.OPEN && device.foreground) || this.pushesInFlight >= 32) continue;
            const candidate = Object.hasOwn(texts, device.language) ? texts[device.language] : null;
            const localized = isRecord(candidate) ? candidate : null;
            const notification = { title: (localized?.title ?? record.title) as string,
              body: (localized?.body ?? record.body) as string, roomId: room.roomId, eventId };
            this.pushesInFlight++;
            void Promise.resolve().then(() => this.options.pushSender!(device.token, notification)).then(result => {
              if (result === 'invalid' && target.pushDevices.get(deviceId) === device) target.pushDevices.delete(deviceId);
              this.trace('push.delivery', { result });
            }).catch(() => this.trace('push.delivery_failed')).finally(() => { this.pushesInFlight--; });
          }
        }
        return;
      }
      case 'updateRoom': {
        if (room.ownerId !== p.playerId) { this.playerError(p, 'not_room_owner'); return; }
        if (room.gameStarted) { this.playerError(p, 'already_started'); return; }
        const maxPlayers = typeof record.maxPlayers === 'number' ? record.maxPlayers : room.maxPlayers;
        const name = typeof record.name === 'string' ? record.name : room.roomName;
        if (maxPlayers < room.active.size) { this.playerError(p, 'room_too_small'); return; }
        const password = Object.hasOwn(record, 'password')
          ? (typeof record.password === 'string' && record.password.length > 0 ? record.password : null)
          : room.password;
        if (!this.roomFits(room, room.roomMeta, maxPlayers, password !== null, name)) {
          this.playerError(p, 'payload_too_large'); return;
        }
        room.maxPlayers = maxPlayers;
        if (typeof record.joinClosed === 'boolean') room.joinClosed = record.joinClosed;
        room.password = password;
        room.roomName = name;
        const updated = { method: 'roomUpdated', data: this.roomDto(room) };
        this.broadcast(room, updated);
        this.lobby(updated);
        this.trace('room.settings_changed', { roomId: room.roomId, ownerId: p.playerId, maxPlayers });
        return;
      }
      case 'sendChatMsg': case 'sendToRoom': case 'sendTo': {
        const outgoing = message.method === 'sendChatMsg'
          ? { method: 'chatMsg', data: { text: d, from: p.playerId } }
          : { method: 'messageFromPlayer', data: { from: p.playerId, msg: message.method === 'sendTo' ? record.msg : d } };
        const json = this.prepareRelay(p, outgoing);
        if (json !== null) this.broadcastJson(room, json, message.method === 'sendToRoom' ? p.playerId : undefined,
          message.method === 'sendTo' ? targets : undefined);
        break;
      }
      case 'requestGameState': {
        const owner = this.players.get(room.ownerId);
        if (owner && this.activeRoom(owner) === room) this.send(owner, { method: 'gameStateRequested', data: p.toNetObject() }); break;
      }
      case 'startGame': case 'shareGameState': case 'setRoomMeta': {
        if (room.ownerId !== p.playerId) { this.playerError(p, 'not_room_owner'); return; }
        if (message.method === 'startGame') {
          if (room.gameStarted) { this.playerError(p, 'already_started'); return; }
          const json = this.prepareRelay(p, { method: 'gameStarted', data: d });
          if (json === null) return;
          room.fixedRoster = record.fixedRoster === true;
          room.hostMigration = room.fixedRoster && record.hostMigration === true;
          room.persistent = !!this.options.sessionDirectory && record.persistent === true && room.hostMigration;
          room.startData = room.persistent ? d : null;
          room.updatedAt = Date.now();
          if (room.fixedRoster) for (const id of room.active) room.gamePlayers.add(id);
          room.gameStarted = true; this.broadcastJson(room, json); this.lobby({ method: 'roomBlock', data: room.roomId });
          this.trace('room.game_started', { roomId: room.roomId, ownerId: p.playerId });
        } else if (message.method === 'shareGameState') {
          const json = this.prepareRelay(p, { method: 'newGameState', data: record.gamestate });
          if (json !== null) this.broadcastJson(room, json, targets ? undefined : p.playerId, targets);
        } else {
          if (!this.roomFits(room, d)) { this.playerError(p, 'payload_too_large'); return; }
          const json = this.prepareRelay(p, { method: 'onSetRoomMeta', data: d });
          if (json === null) return;
          room.roomMeta = d; this.broadcastJson(room, json);
        }
        break;
      }
    }
  }
  private sleepRoom(room: Room): void {
    try {
      this.store.save(room);
      this.rooms.delete(room.roomId);
      for (const id of this.store.prune(new Set(this.rooms.keys()))) this.lobby({ method: 'roomDeleted', data: id });
    } catch { this.log('session save failed; retaining room in memory'); }
  }
  private sessionReply(p: Player, requestId: unknown, data: Record<string, unknown>): void {
    this.send(p, { method: 'sessionReply', data: { requestId, ...data } });
  }
  private uploadChunk(p: Player, room: Room, bytes: Buffer): void {
    const upload = room.upload;
    if (bytes.length < 22 || !upload) return;
    const id = Buffer.from(upload.id.replaceAll('-', ''), 'hex');
    if (!bytes.subarray(1, 17).equals(id) || upload.owner !== p.playerId || room.ownerId !== p.playerId ||
      upload.generation !== room.hostGeneration || bytes.readUInt32BE(17) !== upload.offset ||
      upload.offset + bytes.length - 21 > upload.bytes.length) {
      this.sessionReply(p, upload.id, { error: 'stale_session' }); room.upload = null; return;
    }
    bytes.copy(upload.bytes, upload.offset, 21);
    upload.offset += bytes.length - 21; upload.at = Date.now();
    this.sessionReply(p, upload.id, { offset: upload.offset });
  }
  private sessionMessage(p: Player, room: Room, method: string, data: Record<string, unknown>): void {
    const reply = (value: Record<string, unknown>) => this.sessionReply(p, data.requestId, value);
    if (!room.persistent) { reply({ error: 'unavailable' }); return; }
    if (method === 'getSession') {
      reply({ revision: room.revision, size: room.sessionState.length, startData: room.startData, generation: room.hostGeneration }); return;
    }
    if (method === 'getSessionChunk') {
      const offset = Number(data.offset);
      if (data.revision !== room.revision || offset >= room.sessionState.length) { reply({ error: 'stale_session' }); return; }
      const chunk = room.sessionState.subarray(offset, offset + Math.min(32000, this.options.maxPayloadBytes - 21, this.options.maxBufferedBytes - 31));
      const bytes = Buffer.alloc(21 + chunk.length); bytes[0] = 3;
      Buffer.from((data.requestId as string).replaceAll('-', ''), 'hex').copy(bytes, 1);
      bytes.writeUInt32BE(offset, 17); chunk.copy(bytes, 21); this.sendBytes(p, bytes, true); return;
    }
    if (room.ownerId !== p.playerId) { reply({ error: 'not_room_owner' }); return; }
    if (method === 'beginSession') {
      if (data.revision !== room.revision || data.generation !== room.hostGeneration) { reply({ error: 'stale_session' }); return; }
      if (Number(data.size) > this.options.maxSessionBytes) { reply({ error: 'payload_too_large' }); return; }
      room.upload = { id: data.requestId as string, owner: p.playerId, generation: room.hostGeneration,
        revision: room.revision, bytes: Buffer.alloc(Number(data.size)), offset: 0, at: Date.now() };
      reply({ offset: 0 }); return;
    }
    const upload = room.upload;
    if (!upload || upload.id !== data.requestId || upload.owner !== p.playerId || upload.generation !== room.hostGeneration ||
      upload.revision !== room.revision || upload.offset !== upload.bytes.length) { reply({ error: 'stale_session' }); return; }
    const scheduled = data.scheduled as Notice | null;
    const immediate = data.immediate as Notice | null;
    if ([scheduled, immediate].some(notice => notice?.to.some(id => !room.gamePlayers.has(id)))) { reply({ error: 'invalid_message' }); return; }
    // No client callbacks can interleave between the queued notification write and the state swap.
    try { this.store.commitNotices(room, scheduled, immediate); }
    catch { reply({ error: 'storage_error' }); return; }
    if (immediate) {
      room.pushEvents.add(immediate.eventId);
      if (room.pushEvents.size > 128) room.pushEvents.delete(room.pushEvents.values().next().value!);
    }
    room.sessionState = upload.bytes; room.revision++; room.updatedAt = Date.now(); room.upload = null;
    reply({ revision: room.revision });
    this.broadcast(room, { method: 'sessionUpdated', data: { revision: room.revision } }, p.playerId);
    void this.deliverNotices();
  }
  private async deliverNotices(): Promise<void> {
    if (this.delivering || !this.options.pushSender || this.state !== 'running') return;
    this.delivering = true;
    try {
      for (const [roomId, jobs] of this.store.jobs) for (const job of jobs) {
        if (this.state !== 'running') return;
        if (job.at > Date.now() || job.retryAt > Date.now()) continue;
        let failed = false;
        for (const playerId of job.to) {
          const player = this.players.get(playerId) ?? this.store.account(playerId);
          if (!player) continue;
          for (const [deviceId, device] of player.pushDevices) {
            if (!this.store.jobs.get(roomId)?.includes(job)) break;
            const key = `${playerId}:${deviceId}`;
            if (job.done.includes(key)) continue;
            // An open different match must not suppress this match's notification.
            if (player.ws?.readyState === WebSocket.OPEN && player.roomId === roomId && device.foreground) { job.done.push(key); continue; }
            const text = job.translations?.[device.language] ?? job;
            try {
              const result = await this.options.pushSender(device.token, { title: text.title, body: text.body, roomId, eventId: job.eventId });
              if (result === 'invalid') { player.pushDevices.delete(deviceId); this.store.saveAccount(player); }
              job.done.push(key);
            } catch { failed = true; }
          }
        }
        job.retryAt = failed ? Date.now() + 30000 : Number.MAX_SAFE_INTEGER;
        // A commit or eviction may replace this job while a provider request is in flight.
        const current = this.store.jobs.get(roomId);
        if (this.state === 'running' && current?.includes(job))
          this.store.setJobs(roomId, !failed && !job.scheduled ? current.filter(item => item !== job) : current);
      }
    } catch { this.log('scheduled notification failed'); }
    finally { this.delivering = false; }
  }
  private expireAccounts(now: number): void {
    for (const [id, p] of this.players) if (!p.ws && p.offlineSince !== null && now - p.offlineSince >= this.options.accountTtlMs) {
      if ([...this.rooms.values()].some(room => room.fixedRoster && room.gamePlayers.has(id))) continue;
      for (const room of this.rooms.values()) room.reservations.delete(id);
      this.players.delete(id);
      this.trace('account.expired', { playerId: id });
    }
  }
  private sweep(): void {
    if (this.state !== 'running') return;
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.upload && now - room.upload.at > 30000) room.upload = null;
      if (room.persistent && room.active.size === 0) this.sleepRoom(room);
    }
    void this.deliverNotices();
    // Bound pre-upgrade/partial HTTP transports without introducing another timer.
    for (const [socket, transport] of this.transports) {
      if (!transport.websocket && now - transport.created >= this.options.authTimeoutMs) {
        this.trace('transport.timeout', { connectionId: transport.id }); socket.destroy();
      }
    }
    let heartbeat = false;
    for (const c of this.connections.values()) {
      // A peer can send Close and disappear before the handshake completes.
      // Such sockets no longer receive heartbeats and cannot be active players.
      if (c.ws.readyState !== WebSocket.OPEN) { this.releasePlayer(c); continue; }
      if (!this.current(c)) continue;
      if (!c.player) {
        if (now - c.created >= this.options.authTimeoutMs) this.terminate(c, 'authentication_timeout');
        continue;
      }
      if (now - c.activity >= this.options.idleTimeoutMs || (c.pingAt !== null && now - c.pingAt >= this.options.idleTimeoutMs)) {
        this.terminate(c, 'idle_or_heartbeat_timeout'); continue;
      }
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
