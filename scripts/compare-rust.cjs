'use strict';
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const WebSocket = require('ws');
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const duration = Number(process.env.COMPARE_DURATION_MS || 5000);
const rounds = Number(process.env.COMPARE_ROUNDS || 3);
const pairs = Number(process.env.COMPARE_PAIRS || 16);
const nativeBinaries = process.env.COMPARE_NATIVE_BINARIES ? JSON.parse(process.env.COMPARE_NATIVE_BINARIES) : null;
const variants = nativeBinaries ? Object.keys(nativeBinaries) : ['node', 'rust'];
const sizes = (process.env.COMPARE_SIZES || '512,32000').split(',').map(Number);
async function resources(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${Number(pid)}; @{cpuMs=$p.TotalProcessorTime.TotalMilliseconds; rssBytes=$p.WorkingSet64; peakRssBytes=$p.PeakWorkingSet64; threads=$p.Threads.Count} | ConvertTo-Json -Compress`], { windowsHide: true });
    return JSON.parse(stdout);
  }
  const fs = require('node:fs');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const hz = Number((await run('getconf', ['CLK_TCK'])).stdout.trim());
  return { cpuMs: (Number(stat[13]) + Number(stat[14])) * 1000 / hz, rssBytes: Number(/VmRSS:\s+(\d+)/.exec(status)[1]) * 1024, peakRssBytes: Number(/VmHWM:\s+(\d+)/.exec(status)[1]) * 1024, threads: Number(/Threads:\s+(\d+)/.exec(status)[1]) };
}
async function server(backend) {
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', SESSION_DIRECTORY: '', TELEMETRY_ENABLED: 'false', FCM_ENABLED: 'false', VERBOSE_LOGS: 'false', MAX_CONNECTIONS: '1024', MAX_CONNECTIONS_PER_IP: '1024', MAX_CONNECTIONS_PER_MINUTE: '10000', MAX_MESSAGES_PER_SECOND: '100000', IDLE_TIMEOUT_MS: '120000' };
  delete env.RELAY_TEST_CONTROL;
  const command = nativeBinaries ? nativeBinaries[backend] : backend === 'node' ? process.execPath : join(__dirname, '../target/release/no-logic-game-server' + (process.platform === 'win32' ? '.exe' : ''));
  const child = spawn(command, !nativeBinaries && backend === 'node' ? [join(__dirname, 'node-process.cjs')] : [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', b => process.stderr.write(b));
  const exited = new Promise(resolve => child.once('exit', resolve));
  const address = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error('Server startup exited: ' + code)));
    createInterface({ input: child.stdout }).on('line', line => { const v = JSON.parse(line); if (v.event === 'server.listening') resolve(v.address); });
  });
  return { child, url: `ws://127.0.0.1:${address.port}/`, stop: async () => { child.stdin.end('stop\n'); await exited; } };
}
async function client(url) {
  const ws = new WebSocket(url); const queue = [], waiters = [];
  const c = { ws, failed: null, onBinary: () => {}, send: (method, data) => ws.send(JSON.stringify({ method, data })), wait: method => new Promise((resolve, reject) => {
    const i = queue.findIndex(v => v.method === method); if (i >= 0) return resolve(queue.splice(i, 1)[0]);
    const timer = setTimeout(() => reject(new Error('Timed out: ' + method)), 5000);
    waiters.push({ method, resolve: v => { clearTimeout(timer); resolve(v); } });
  }) };
  ws.on('error', e => { c.failed = e; });
  ws.on('message', (b, binary) => {
    if (binary) return c.onBinary(b);
    const v = JSON.parse(b);
    if (v.method === 'Ping') return c.send('Pong', v.data);
    if (v.method === 'error') c.failed = new Error(v.data.code);
    const i = waiters.findIndex(w => w.method === v.method); if (i >= 0) waiters.splice(i, 1)[0].resolve(v); else queue.push(v);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  c.send('authenticate', {}); c.account = (await c.wait('accountCreated')).data; await c.wait('onConnected');
  return c;
}
async function measure(backend, bytes, round) {
  const instance = await server(backend), clients = [], senders = [];
  let measuring = false, active = true, received = 0, latencies = [], pending = 0;
  const send = c => { const b = Buffer.alloc(bytes); b[0] = 1; b.writeDoubleBE(performance.now(), 17); pending++; c.ws.send(b); };
  try {
    const idle = await resources(instance.child.pid);
    for (let i = 0; i < pairs; i++) {
      const a = await client(instance.url), b = await client(instance.url); clients.push(a, b); senders.push(a);
      a.send('createRoom', { name: 'Benchmark', maxPlayers: 2, binaryRelay: true }); const room = (await a.wait('onRoomEnter')).data;
      b.send('enterRoom', { roomId: room.roomId }); await b.wait('onRoomEnter');
      b.onBinary = bytes => b.ws.send(bytes); // authenticated sender header is the return target
      a.onBinary = bytes => { pending--; if (measuring) { received++; latencies.push(performance.now() - bytes.readDoubleBE(17)); } if (active) send(a); };
    }
    for (const c of senders) send(c);
    await sleep(1000); active = false; while (pending) await sleep(1);
    const before = await resources(instance.child.pid);
    active = true; measuring = true; const start = performance.now();
    for (const c of senders) send(c);
    await sleep(duration); active = false; while (pending) await sleep(1);
    const elapsed = performance.now() - start; measuring = false;
    const after = await resources(instance.child.pid);
    for (const c of clients) if (c.failed) throw c.failed;
    latencies.sort((a, b) => a - b);
    const p = q => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
    return { backend, round, bytes, pairs, clients: clients.length, elapsedMs: elapsed, roundTrips: received, roundTripsPerSecond: received * 1000 / elapsed, relayMessagesPerSecond: received * 2000 / elapsed, latencyMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99) }, cpuMs: after.cpuMs - before.cpuMs, cpuMsPer1000RoundTrips: (after.cpuMs - before.cpuMs) * 1000 / received, idleRssBytes: idle.rssBytes, rssBytes: after.rssBytes, peakRssBytes: after.peakRssBytes, threads: after.threads };
  } finally { active = false; for (const c of clients) c.ws.terminate(); await instance.stop(); }
}
async function main() {
  const results = [];
  for (let round = 1; round <= rounds; round++) for (const bytes of sizes) for (const backend of round % 2 ? variants : [...variants].reverse()) {
    const result = await measure(backend, bytes, round); results.push(result); console.log(JSON.stringify(result));
  }
  const report = { timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch, cpu: require('node:os').cpus()[0]?.model, logicalCpus: require('node:os').cpus().length, node: process.version, methodology: `Separate server and load processes on one machine; 1s warmup; closed-loop ${pairs} independent 2-peer rooms; two relay hops per RTT; no storage, push or telemetry; alternating order. Process CPU/RSS via ${process.platform === 'win32' ? 'Get-Process' : '/proc'}. Loopback without TLS, not a capacity guarantee.`, results };
  const output = process.env.COMPARE_OUTPUT || join(__dirname, '../docs/benchmarks/rust-comparison.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
