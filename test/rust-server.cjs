'use strict';
// Process adapter: existing wire tests speak to the Rust executable unchanged.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const instances = new Map();
let sequence = 0;
class Server {
  constructor(options = {}) {
    this.currentStats = { accounts: 0, online: 0, rooms: 0, pendingConnections: 0 };
    this.rooms = new Map();
    this.syncs = new Map();
    this.store = { jobs: new Map(),
      load: id => new (require('../dist/SessionStore').SessionStore)(options.sessionDirectory, options.sessionMaxBytes ?? 1024 ** 3).load(id),
      account: id => new (require('../dist/SessionStore').SessionStore)(options.sessionDirectory, options.sessionMaxBytes ?? 1024 ** 3).account(id),
    };
    this.options = new Proxy(options, { set: (target, key, value) => {
      target[key] = value;
      this.child?.stdin.write(JSON.stringify({ options: { [key]: value } }) + '\n');
      return true;
    } });
  }
  async start() {
    if (this.starting) return this.starting;
    const env = { ...process.env, SESSION_DIRECTORY: '', FCM_ENABLED: 'false', TELEMETRY_ENABLED: 'false', RELAY_TEST_CONTROL: '1' };
    for (const [key, value] of Object.entries(this.options)) {
      if (typeof value === 'function' || value === null) continue;
      env[key.replace(/[A-Z]/g, s => '_' + s).toUpperCase()] = Array.isArray(value) ? value.join(',') : String(value);
    }
    if (this.options.pushSender) {
      this.pushHttp = require('node:http').createServer(async (req, res) => {
        try {
          let body = ''; for await (const b of req) body += b;
          const { token, notification } = JSON.parse(body);
          const result = await this.options.pushSender(token, notification);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
        } catch { res.writeHead(503); res.end(); }
      });
      await new Promise(resolve => this.pushHttp.listen(0, '127.0.0.1', resolve));
      env.FCM_ENABLED = 'true'; env.RELAY_TEST_PUSH_URL = 'http://127.0.0.1:' + this.pushHttp.address().port;
    }
    this.child = spawn(process.env.RUST_SERVER_BINARY || path.join(__dirname, '../target/debug/no-logic-game-server' + (process.platform === 'win32' ? '.exe' : '')), [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('exit', resolve));
    this.starting = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('exit', code => { if (!this.addr) reject(new Error('Rust server exited: ' + code)); });
      createInterface({ input: this.child.stdout }).on('line', line => {
        const record = JSON.parse(line);
        if (record.sync) { this.syncs.get(record.sync)?.(); this.syncs.delete(record.sync); }
        if (record.observe) { try { this.options.telemetry?.(record.observe, record.details); } catch { /* Observer failures are isolated. */ } }
        if (record.log) { try { this.options.logger?.(record.log); } catch { /* A diagnostic sink cannot interrupt tests. */ } }
        if (record.stats) this.currentStats = record.stats;
        if (record.rooms) this.rooms = new Map(record.rooms.map(([id, r]) => [id, { ...r, active: new Set(r.active), sessionState: Buffer.from(r.sessionState, 'base64'), upload: r.upload && new Proxy(r.upload, { set: (t, k, v) => { t[k] = v; this.child.stdin.write(JSON.stringify({ uploadAt: { id, at: v } }) + '\n'); return true; } }) }]));
        if (record.jobs) this.store.jobs = new Map(Object.entries(record.jobs).map(([id, jobs]) => [id, jobs.map((j, index) => new Proxy(j, { set: (t, k, v) => { t[k] = v; this.child.stdin.write(JSON.stringify({ jobRetry: { id, index, at: v } }) + '\n'); return true; } }))]));
        if (record.event === 'server.listening') { this.addr = record.address; instances.set(record.address.port, this); resolve(); }
      });
      this.child.stderr.on('data', b => { try { this.options.logger?.(b.toString().trim()); } catch { /* A diagnostic sink cannot interrupt tests. */ } });
    });
    return this.starting;
  }
  stats() { return this.currentStats; }
  sync() {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.writableEnded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { this.syncs.delete(id); reject(new Error('Rust test-control synchronization timed out')); }, 2500);
      this.syncs.set(id, () => { clearTimeout(timer); resolve(); });
      this.child.stdin.write(JSON.stringify({ sync: id }) + '\n');
    });
  }
  address() { return this.addr ?? null; }
  stop() {
    return this.stopping ??= (async () => {
      if (!this.child) return;
      if (this.child.exitCode === null) this.child.stdin.end('stop\n');
      await this.exited;
      for (const done of this.syncs.values()) done(); this.syncs.clear();
      if (this.addr) instances.delete(this.addr.port);
      await new Promise(resolve => this.pushHttp ? this.pushHttp.close(resolve) : resolve());
      this.addr = null;
      this.currentStats = { accounts: 0, online: 0, rooms: 0, pendingConnections: 0 };
    })();
  }
}
module.exports = { Server, sync: url => instances.get(Number(new URL(url).port))?.sync() ?? Promise.resolve() };
