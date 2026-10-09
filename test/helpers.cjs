'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const net = require('node:net');
const { Server } = require('../dist/Server.js');

const TIMEOUT = 2500;

async function eventually(predicate, description = 'condition', timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

async function startServer(t, options = {}) {
  const server = new Server({
    host: '127.0.0.1', port: 0, logger: () => {},
    heartbeatIntervalMs: 10000, idleTimeoutMs: 30000,
    authTimeoutMs: 1000, maintenanceIntervalMs: 10, shutdownTimeoutMs: 200,
    ...options,
  });
  t.after(async () => { await server.stop(); });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `ws://127.0.0.1:${address.port}/`, http: `http://127.0.0.1:${address.port}` };
}

class Client {
  constructor(url, options = {}) {
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.ws = new WebSocket(url, { handshakeTimeout: TIMEOUT, ...options });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('close', () => reject(new Error('Closed before open')));
    });
    // Failed handshakes are deliberately tested; avoid unhandled rejection races.
    this.opened.catch(() => {});
    this.closePromise = new Promise(resolve => {
      this.ws.once('close', (code, reason) => {
        this.closed = true;
        resolve({ code, reason: reason.toString() });
        for (const waiter of [...this.waiters]) {
          waiter.reject(new Error('Socket closed while awaiting message'));
        }
      });
    });
    this.ws.on('error', () => {});
    this.ws.on('message', (bytes, binary) => {
      let message;
      if (binary) message = { binary: true, data: Buffer.from(bytes) };
      else {
        try { message = JSON.parse(bytes.toString()); }
        catch { message = { invalidJSON: bytes.toString() }; }
      }
      const waiter = this.waiters.find(item => item.matches(message));
      if (waiter) waiter.resolve(message);
      else this.messages.push(message);
    });
  }

  send(method, data) { this.ws.send(JSON.stringify({ method, data })); }

  wait(method, predicate = () => true, timeout = TIMEOUT) {
    const matches = message => message !== null && typeof message === 'object' &&
      (method === 'binary' ? message.binary : message.method === method) && predicate(message.data, message);
    const index = this.messages.findIndex(matches);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);
    if (this.closed) return Promise.reject(new Error(`Socket closed awaiting ${method}`));
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
      };
      const waiter = {
        matches,
        resolve: value => { remove(); resolve(value); },
        reject: error => { remove(); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new Error(`Timed out awaiting ${method}`)), timeout);
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (!this.closed) this.ws.terminate();
    await this.closePromise;
  }

  async barrier() {
    this.send('getPlayers', null);
    return (await this.wait('onGetPlayers')).data;
  }

  assertNo(method, predicate = () => true) {
    assert.equal(this.messages.some(message =>
      message !== null && typeof message === 'object' &&
      (method === 'binary' ? message.binary : message.method === method) && predicate(message.data)), false,
    `Unexpected ${method}`);
  }
}

function rawClient(t, url, options) {
  const client = new Client(url, options);
  t.after(() => client.close());
  return client;
}

async function connect(t, url, credentials = {}, options) {
  const client = rawClient(t, url, options);
  await client.opened;
  client.send('authenticate', credentials);
  if (!credentials.playerId) client.account = (await client.wait('accountCreated')).data;
  else client.account = credentials;
  await client.wait('onConnected');
  return client;
}

async function createRoom(client, data = {}) {
  client.send('createRoom', { name: 'Test room', maxPlayers: 4, gameData: null, ...data });
  return (await client.wait('onRoomEnter')).data;
}

async function enterRoom(client, room, password) {
  client.send('enterRoom', { roomId: room.roomId, ...(password === undefined ? {} : { password }) });
  return (await client.wait('onRoomEnter')).data;
}

async function expectError(client, method, data, code) {
  client.send(method, data);
  assert.equal((await client.wait('error')).data.code, code);
}

async function waitClosed(client, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      client.closePromise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Socket did not close')), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function within(promise, description, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeout);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function rawTcp(t, url) {
  const address = new URL(url);
  const socket = net.createConnection({ host: address.hostname, port: Number(address.port) });
  const transport = { socket, response: '', closePromise: null };
  transport.closePromise = new Promise(resolve => socket.once('close', resolve));
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  socket.on('data', chunk => { transport.response = (transport.response + chunk).slice(-8192); });
  t.after(async () => { socket.destroy(); await transport.closePromise; });
  await within(new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  }), 'TCP connection');
  return transport;
}

module.exports = { TIMEOUT, eventually, startServer, rawClient, connect, createRoom, enterRoom, expectError, waitClosed, within, rawTcp };
