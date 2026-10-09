'use strict';
const { performance } = require('node:perf_hooks');
const WebSocket = require('ws');
const { Server } = require('../dist/Server.js');

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

async function main() {
  const count = integer('BENCH_CLIENTS', 8, 1, 64);
  const duration = integer('BENCH_DURATION_MS', 2000, 100, 10000);
  const interval = integer('BENCH_INTERVAL_MS', 25, 10, 1000);
  const server = new Server({
    host: '127.0.0.1', port: 0, logger: () => {},
    maxConnections: count, maxConnectionsPerIp: count,
    maxConnectionsPerMinute: count + 10, maxAccounts: count,
    maxMessagesPerSecond: 200,
  });
  const clients = [];
  const latencies = [];
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const wait = ms => new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abort.signal.addEventListener('abort', done, { once: true });
    if (abort.signal.aborted) done();
  });
  try {
    await server.start();
    const url = `ws://127.0.0.1:${server.address().port}/`;
    for (let i = 0; i < count; i++) {
      if (abort.signal.aborted) throw new Error('Benchmark interrupted');
      const ws = new WebSocket(url);
      const client = { ws, pending: null, failure: null };
      clients.push(client);
      const fail = error => {
        client.failure = error;
        client.pending?.reject(error);
      };
      ws.on('error', fail);
      ws.on('close', () => fail(new Error('Client closed unexpectedly')));
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.method === 'Ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ method: 'Pong', data: message.data }));
            }
          } else if (message.method === 'error' || message.method === 'wrongPassword') {
            fail(new Error('Server rejected benchmark request'));
          } else if (message.method === client.pending?.method) {
            client.pending.resolve();
          }
        } catch (error) { fail(error); }
      });
      client.request = (method, send) => new Promise((resolve, reject) => {
        if (client.failure) { reject(client.failure); return; }
        const cleanup = () => {
          clearTimeout(timer);
          client.pending = null;
          abort.signal.removeEventListener('abort', interrupted);
        };
        const interrupted = () => { cleanup(); reject(new Error('Benchmark interrupted')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Response timeout')); }, 3000);
        client.pending = {
          method,
          resolve: () => { cleanup(); resolve(); },
          reject: error => { cleanup(); reject(error); },
        };
        abort.signal.addEventListener('abort', interrupted, { once: true });
        if (abort.signal.aborted) { interrupted(); return; }
        try { send(); } catch (error) { cleanup(); reject(error); }
      });
      await client.request('onConnected', () => {
        ws.once('open', () => ws.send(JSON.stringify({ method: 'authenticate', data: {} })));
      });
    }
    const started = performance.now();
    await Promise.all(clients.map(async client => {
      while (performance.now() - started < duration && !abort.signal.aborted) {
        const before = performance.now();
        await client.request('onGetPlayers', () => {
          client.ws.send(JSON.stringify({ method: 'getPlayers' }));
        });
        latencies.push(performance.now() - before);
        await wait(interval);
      }
    }));
    if (abort.signal.aborted) throw new Error('Benchmark interrupted');
    const elapsed = performance.now() - started;
    latencies.sort((a, b) => a - b);
    const percentile = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? null;
    console.log(JSON.stringify({
      workload: 'authenticated getPlayers round trips', clients: count,
      durationMs: elapsed, requests: latencies.length,
      requestsPerSecond: latencies.length * 1000 / elapsed,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null },
      note: 'Local bounded smoke measurement; not a capacity or performance guarantee.',
    }, null, 2));
  } finally {
    abort.abort();
    for (const { ws } of clients) ws.terminate();
    await server.stop();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
