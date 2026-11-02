'use strict';
// Isolated local lifecycle test. Never connects to a public/production endpoint.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { connect, createRoom, enterRoom } = require('../test/helpers.cjs');
const resources = require('./process-resources.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cycles = Number(process.env.CHURN_CYCLES || 30);
const clientsPerCycle = Number(process.env.CHURN_CLIENTS || 64);
const payloadBytes = Number(process.env.CHURN_STATE_BYTES || 131072);
const delayMs = Number(process.env.CHURN_DELAY_MS || 0);
assert.ok(Number.isInteger(cycles) && cycles > 0 && cycles <= 1000);
assert.ok(Number.isInteger(clientsPerCycle) && clientsPerCycle >= 4 && clientsPerCycle % 4 === 0);
assert.ok(payloadBytes > 0 && payloadBytes <= 1024 * 1024);
const output = resolve(process.env.CHURN_OUTPUT || 'test-results/memory-churn/report.json');
mkdirSync(dirname(output), { recursive: true });
const directory = mkdtempSync(join(dirname(output), 'sessions-'));
const executable = resolve(process.env.RUST_SERVER_BINARY || 'target/release/no-logic-game-server' + (process.platform === 'win32' ? '.exe' : ''));
const binarySha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', SESSION_DIRECTORY: directory, SESSION_MAX_BYTES: String(8 * 1024 * 1024), MAX_CONNECTIONS: String(clientsPerCycle + 16), MAX_CONNECTIONS_PER_IP: String(clientsPerCycle + 16), MAX_CONNECTIONS_PER_MINUTE: '100000', MAX_ACCOUNTS: String(clientsPerCycle * 2), MAX_ROOMS: String(clientsPerCycle), MAX_MESSAGES_PER_SECOND: '10000', ACCOUNT_TTL_MS: '300', MAINTENANCE_INTERVAL_MS: '50', SEND_DELAY_MS: String(delayMs), SHUTDOWN_TIMEOUT_MS: '300', VERBOSE_LOGS: 'false', FCM_ENABLED: 'false', TELEMETRY_ENABLED: 'false' };
delete env.RELAY_TEST_CONTROL;
const child = spawn(executable, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.on('data', bytes => process.stderr.write(bytes));
const exited = new Promise(resolve => child.once('exit', resolve));
const started = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => reject(new Error('Server exited during startup: ' + code)));
  createInterface({ input: child.stdout }).on('line', line => {
    const row = JSON.parse(line);
    if (row.event === 'server.listening') resolve(row.address.port);
  });
});
async function reply(client, method, data = {}) {
  const requestId = data.requestId || randomUUID();
  client.send(method, { ...data, requestId });
  const result = (await client.wait('sessionReply', d => d.requestId === requestId, 5000)).data;
  assert.equal(result.error, undefined);
  return result;
}
async function save(client, bytes) {
  const requestId = randomUUID();
  await reply(client, 'beginSession', { requestId, size: bytes.length, revision: 0, generation: 0 });
  for (let offset = 0; offset < bytes.length; offset += 32000) {
    const chunk = bytes.subarray(offset, offset + 32000), frame = Buffer.alloc(21 + chunk.length);
    frame[0] = 2; Buffer.from(requestId.replaceAll('-', ''), 'hex').copy(frame, 1);
    frame.writeUInt32BE(offset, 17); chunk.copy(frame, 21); client.ws.send(frame);
    assert.equal((await client.wait('sessionReply', d => d.requestId === requestId, 5000)).data.offset, offset + chunk.length);
  }
  assert.equal((await reply(client, 'commitSession', { requestId, scheduled: null, immediate: null })).revision, 1);
}
async function main() {
  const port = await started, url = `ws://127.0.0.1:${port}/`, http = `http://127.0.0.1:${port}/healthz`;
  const health = async () => (await fetch(http, { signal: AbortSignal.timeout(3000) })).json();
  const baseline = await resources(child.pid), rounds = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const cleanup = [], context = { after: fn => cleanup.push(fn) };
    const clients = [];
    try {
      for (let i = 0; i < clientsPerCycle; i++) {
        const client = await connect(context, url);
        client.ws.on('message', (raw, binary) => {
          if (!binary) { const v = JSON.parse(raw); if (v.method === 'Ping') client.send('Pong', v.data); }
        });
        clients.push(client);
      }
      for (let i = 0; i < clients.length; i += 4) {
        const host = clients[i], room = await createRoom(host, { binaryRelay: true });
        for (const peer of clients.slice(i + 1, i + 4)) await enterRoom(peer, room);
        host.send('startGame', { fixedRoster: true, hostMigration: true, persistent: true }); await host.wait('gameStarted');
        await save(host, Buffer.alloc(payloadBytes, cycle & 255));
        // Keep an unfinished allocation too: it must disappear when its owner leaves.
        await reply(host, 'beginSession', { revision: 1, generation: 0, size: payloadBytes * 2 });
        for (const client of clients.slice(i, i + 4)) client.send('sendToRoom', { padding: 'x'.repeat(1024) });
      }
      const loaded = await resources(child.pid);
      // Alternate explicit leave and abrupt transport loss, including queued relay traffic.
      if (cycle % 2) {
        for (const client of clients) client.send('leaveRoom');
        for (const client of clients) await client.barrier();
      }
      for (const close of cleanup) await close(); cleanup.length = 0;
      let after;
      const deadline = Date.now() + 10000;
      for (;;) {
        after = await health();
        assert.equal(after.status, 'ok');
        if (after.accounts === 0 && after.online === 0 && after.rooms === 0 && after.pendingConnections === 0) break;
        assert.ok(Date.now() < deadline, 'Lifecycle state did not return to zero: ' + JSON.stringify(after));
        await sleep(50);
      }
      const idle = await resources(child.pid);
      rounds.push({ cycle, loaded, idle, health: after });
      console.log(JSON.stringify({ cycle, privateMiB: +(idle.privateBytes / 1048576).toFixed(2), rssMiB: +(idle.rssBytes / 1048576).toFixed(2), handles: idle.handles, health: after }));
    } finally { for (const close of cleanup.reverse()) await close(); }
  }
  const report = { timestamp: new Date().toISOString(), platform: process.platform, node: process.version, executable, binarySha256, cycles, clientsPerCycle, connectionsCreated: cycles * clientsPerCycle, stateBytesPerRoom: payloadBytes, partialUploadBytesPerRoom: payloadBytes * 2, delayMs, accountTtlMs: 300, sessionDiskQuotaBytes: 8 * 1024 * 1024, methodology: 'One server process; repeated rooms, persisted states, unfinished uploads, normal leave and abrupt close; all live health counters must return to zero after TTL. Windows private committed bytes / Linux anonymous RSS; RSS alone may retain allocator high-water memory. This is a churn check, not proof that every execution is leak-free.', baseline, rounds };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  child.stdin.end('stop\n');
  const timeout = setTimeout(() => child.kill(), 10000);
  await exited; clearTimeout(timeout);
});
