'use strict';
const WebSocket = require('../tools/dependencies.cjs')('ws');
const { performance } = require('node:perf_hooks');
const url = process.argv[2];
if (!url || new URL(url).protocol !== 'wss:') throw new Error('Pass an authorized WSS endpoint');
const samples = [];
const ws = new WebSocket(url, { origin: 'https://apxapob.com', handshakeTimeout: 15000 });
let start;
const timer = setTimeout(() => { console.error('Network probe timeout'); ws.terminate(); process.exitCode = 1; }, 90000);
function ping() { start = performance.now(); ws.ping(Buffer.from('probe')); }
ws.on('open', () => ws.send(JSON.stringify({ method: 'authenticate', data: { name: 'Network baseline check' } })));
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.method === 'onConnected') ping();
  if (msg.method === 'Ping') ws.send(JSON.stringify({ method: 'Pong', data: msg.data }));
});
ws.on('pong', () => {
  samples.push(performance.now() - start);
  if (samples.length < 50) setTimeout(ping, 100);
  else {
    samples.sort((a,b) => a-b);
    console.log(JSON.stringify({ time: new Date().toISOString(), samples: samples.length, p50Ms: samples[24], p95Ms: samples[47], maxMs: samples.at(-1) }));
    clearTimeout(timer); ws.close();
  }
});
ws.on('error', e => { console.error(e.message); clearTimeout(timer); process.exitCode = 1; });
ws.on('close', () => { clearTimeout(timer); if (samples.length !== 50) process.exitCode = 1; });
