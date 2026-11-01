'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const run = randomUUID().slice(0, 8);
const output = path.resolve(cfg.output);
const clients = [];
const groups = [];
const results = [];
let active = null;
let finishing = false;
let fatal = null;
let epoch = 0;
let nextIndex = 0;
let rampRetries = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = record => { fs.appendFileSync(output, JSON.stringify(record) + '\n'); console.log(JSON.stringify(record)); };
const fail = message => { fatal ??= new Error(message); };

class Histogram {
  constructor() { this.bins = new Uint32Array(10002); this.count = 0; this.total = 0; this.max = 0; }
  add(value) { this.bins[Math.min(10001, Math.max(0, Math.floor(value)))]++; this.count++; this.total += value; this.max = Math.max(this.max, value); }
  percentile(p) { if (!this.count) return null; const target = Math.ceil(this.count * p); let count = 0; for (let i = 0; i < this.bins.length; i++) { count += this.bins[i]; if (count >= target) return i; } return null; }
  json() { return { samples: this.count, p50: this.percentile(.5), p95: this.percentile(.95), p99: this.percentile(.99), max: Math.round(this.max), mean: this.count ? +(this.total / this.count).toFixed(2) : null }; }
}

class Client {
  constructor(index) {
    this.index = index; this.id = null; this.room = null; this.inbox = new Map(); this.waiters = new Map(); this.seen = new Map(); this.expectedClose = false; this.sequence = 0; this.established = false;
    this.ws = new WebSocket(cfg.url, { origin: 'https://apxapob.com', handshakeTimeout: 15000, perMessageDeflate: false });
    clients.push(this);
    this.ws.on('open', () => this.send('authenticate', { name: `load-${run}-${index}` }));
    this.ws.on('error', error => { if (!finishing && !this.expectedClose && this.established) fail(`Client ${index}: ${error.message}`); });
    this.ws.on('close', (code, reason) => {
      for (const waiter of this.waiters.values()) waiter.reject(new Error('Connection closed'));
      this.waiters.clear();
      if (!finishing && !this.expectedClose && this.established) { if (active) active.disconnects++; fail(`Unexpected close ${index}: ${code} ${reason.toString().slice(0, 80)}`); }
    });
    this.ws.on('message', (bytes, binary) => {
      if (binary) { fail('Unexpected binary response'); return; }
      let msg;
      try { msg = JSON.parse(bytes.toString()); } catch { fail('Invalid JSON response'); return; }
      if (msg.method === 'Ping') { if (this.ws.readyState === WebSocket.OPEN) this.send('Pong', msg.data); return; }
      if (msg.method === 'accountCreated') { this.id = msg.data.playerId; return; }
      if (msg.method === 'error' || msg.method === 'wrongPassword') {
        if (active) active.errors++;
        fail(`Server rejected request: ${msg.data?.code ?? msg.method}`);
        return;
      }
      const data = msg.method === 'newGameState' ? msg.data : msg.method === 'messageFromPlayer' ? msg.data.msg : null;
      if (active && data?.lt === run && data.e === active.epoch) {
        const key = `${data.e}:${data.s}`;
        const previous = this.seen.get(key) ?? -1;
        if (data.q <= previous) active.duplicates++;
        this.seen.set(key, data.q);
        active.received++;
        active.receivedBytes += bytes.length;
        active.latency.add(performance.now() - data.t);
        return;
      }
      if (['onConnected', 'onRoomEnter', 'gameStarted', 'onGetRooms'].includes(msg.method)) {
        const waiter = this.waiters.get(msg.method);
        if (waiter) { this.waiters.delete(msg.method); waiter.resolve(msg.data); }
        else this.inbox.set(msg.method, msg.data);
      }
    });
  }
  send(method, data) { this.ws.send(JSON.stringify({ method, data })); }
  wait(method) {
    if (this.inbox.has(method)) { const value = this.inbox.get(method); this.inbox.delete(method); return Promise.resolve(value); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(method); reject(new Error(`Timeout awaiting ${method}`)); }, 15000);
      this.waiters.set(method, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
}

async function addRoomOnce() {
  const members = Array.from({ length: cfg.roomSize }, () => new Client(nextIndex++));
  try {
  await Promise.all(members.map(client => client.wait('onConnected')));
  if (fatal) throw fatal;
  const owner = members[0];
  owner.send('createRoom', { name: `load-${run}-${owner.index}`, maxPlayers: cfg.roomSize });
  const room = await owner.wait('onRoomEnter');
  await Promise.all(members.slice(1).map(async client => { client.send('enterRoom', { roomId: room.roomId }); await client.wait('onRoomEnter'); }));
  owner.send('startGame', { loadtest: run });
  await Promise.all(members.map(client => client.wait('gameStarted')));
  for (const client of members) { client.room = room.roomId; client.owner = owner; client.established = true; }
  groups.push(members);
  } catch (error) {
    for (const client of members) { client.expectedClose = true; client.ws.terminate(); const i = clients.indexOf(client); if (i >= 0) clients.splice(i, 1); }
    throw error;
  }
}

async function addRoom() {
  for (let attempt = 0; ; attempt++) {
    try { await addRoomOnce(); return; }
    catch (error) {
      if (fatal || attempt >= (cfg.rampRetryLimit ?? 0)) throw error;
      rampRetries++;
      emit({ event: 'ramp_retry', run, attempt: attempt + 1, message: error.message, time: new Date().toISOString() });
      await sleep(1000);
    }
  }
}

async function ramp(count) {
  if (count % cfg.roomSize) throw new Error('Client counts must be divisible by room size');
  const started = performance.now();
  while (clients.length < count) {
    const batch = Math.min(cfg.rampRooms ?? 4, (count - clients.length) / cfg.roomSize);
    await Promise.all(Array.from({ length: batch }, () => addRoom()));
    if (fatal) throw fatal;
    await sleep(cfg.rampPauseMs ?? 200);
  }
  emit({ event: 'ramp', run, clients: count, rooms: groups.length, retries: rampRetries, seconds: +((performance.now() - started) / 1000).toFixed(2), time: new Date().toISOString() });
}

async function stage(count, duration, measured) {
  const hist = new Histogram();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpuBefore = process.cpuUsage();
  const period = 1000 / cfg.hz;
  const started = performance.now();
  const startTime = new Date().toISOString();
  const current = { epoch: ++epoch, received: 0, receivedBytes: 0, sent: 0, sentBytes: 0, expected: 0, errors: 0, duplicates: 0, disconnects: 0, missedTicks: 0, maxBuffered: 0, latency: hist };
  active = current;
  for (const [position, client] of clients.entries()) {
    client.next = started + position * period / count;
    client.seen.clear();
  }
  const pads = { state: 'x'.repeat(Math.max(0, cfg.stateBytes - 100)), input: 'y'.repeat(Math.max(0, cfg.inputBytes - 100)) };
  const timer = setInterval(() => {
    const now = performance.now();
    for (const client of clients) {
      if (now < client.next || client.ws.readyState !== WebSocket.OPEN) continue;
      const missed = Math.floor((now - client.next) / period);
      current.missedTicks += missed;
      client.next += (missed + 1) * period;
      const owner = client === client.owner;
      const data = { lt: run, e: current.epoch, s: client.index, q: client.sequence++, t: +performance.now().toFixed(2), pad: owner ? pads.state : pads.input };
      const message = owner ? { method: 'shareGameState', data: { gamestate: data } } : { method: 'sendTo', data: { to: [client.owner.id], msg: data } };
      const text = JSON.stringify(message);
      current.maxBuffered = Math.max(current.maxBuffered, client.ws.bufferedAmount);
      if (client.ws.bufferedAmount > 1024 * 1024) { fail('Load generator send buffer exceeded 1 MiB'); return; }
      client.ws.send(text);
      current.sent++; current.sentBytes += Buffer.byteLength(text);
      current.expected += owner ? cfg.roomSize - 1 : 1;
    }
  }, 5);
  const progress = setInterval(() => {
    emit({ event: 'progress', run, profile: cfg.profile, clients: count, seconds: Math.round((performance.now() - started) / 1000), sent: current.sent, received: current.received, latencyP95Ms: hist.percentile(.95), disconnects: current.disconnects });
  }, 30000);
  while (performance.now() - started < duration * 1000 && !fatal) await sleep(100);
  clearInterval(timer);
  clearInterval(progress);
  const stopTime = new Date().toISOString();
  const elapsed = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuBefore);
  const loopP99 = loop.percentile(99) / 1e6;
  loop.disable();
  const drainStart = performance.now();
  while (current.received < current.expected && performance.now() - drainStart < 5000 && !fatal) await sleep(50);
  active = null;
  const result = {
    event: measured ? 'stage' : 'warmup', run, epoch: current.epoch, profile: cfg.profile, clients: count, rooms: groups.length, roomSize: cfg.roomSize,
    hzPerClient: cfg.hz, stateTargetBytes: cfg.stateBytes, inputTargetBytes: cfg.inputBytes,
    startTime, stopTime, durationSeconds: +elapsed.toFixed(2),
    sent: current.sent, expectedDeliveries: current.expected, received: current.received,
    deliveryPercent: +(100 * current.received / Math.max(1, current.expected)).toFixed(4),
    offeredRatePercent: +(100 * current.sent / Math.max(1, count * cfg.hz * elapsed)).toFixed(2),
    sendMessagesPerSecond: +(current.sent / elapsed).toFixed(1), receiveMessagesPerSecond: +(current.received / elapsed).toFixed(1),
    sendMbps: +(current.sentBytes * 8 / elapsed / 1e6).toFixed(3), receiveMbps: +(current.receivedBytes * 8 / elapsed / 1e6).toFixed(3),
    relayLatencyMs: hist.json(), errors: current.errors, disconnects: current.disconnects, duplicates: current.duplicates,
    generator: { cpuOneCorePercent: +((cpu.user + cpu.system) / elapsed / 10000).toFixed(1), eventLoopP99Ms: +loopP99.toFixed(2), missedTicks: current.missedTicks, maxBufferedBytes: current.maxBuffered, rssMiB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1) },
    failure: fatal?.message ?? null,
  };
  emit(result);
  if (measured) results.push(result);
  return result;
}

async function main() {
  if (!['wss:', 'ws:'].includes(new URL(cfg.url).protocol)) throw new Error('Expected WebSocket URL');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  emit({ event: 'start', run, config: cfg, node: process.version, wsVersion: require('ws/package.json').version, time: new Date().toISOString() });
  for (const count of cfg.levels) {
    await ramp(count);
    await stage(count, cfg.warmupSeconds ?? 5, false);
    if (fatal) break;
    const result = await stage(count, cfg.durationSeconds ?? 60, true);
    if (fatal || result.deliveryPercent < 99.9 || result.offeredRatePercent < 95 || result.relayLatencyMs.p95 > (cfg.stopP95Ms ?? 500)) {
      emit({ event: 'stopped', reason: fatal?.message ?? 'Quality threshold exceeded', clients: count });
      break;
    }
    await sleep(1000);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => fail(`Interrupted by ${signal}`));
main().catch(error => { fail(error.message); emit({ event: 'failure', message: error.message, time: new Date().toISOString() }); process.exitCode = 1; }).finally(async () => {
  finishing = true;
  for (let i = 0; i < clients.length; i += 32) { for (const client of clients.slice(i, i + 32)) { client.expectedClose = true; client.ws.close(); } await sleep(30); }
  await sleep(1000);
  for (const client of clients) client.ws.terminate();
  emit({ event: 'complete', run, testedClients: clients.length, stages: results.length, failure: fatal?.message ?? null, time: new Date().toISOString() });
});
