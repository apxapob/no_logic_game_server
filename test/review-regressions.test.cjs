'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const {
  eventually, startServer, rawClient, connect, createRoom, enterRoom, expectError, waitClosed,
} = require('./helpers.cjs');

const bytes = value => Buffer.byteLength(JSON.stringify(value));

async function page(client, data) {
  client.send('getRooms', data);
  return client.wait('onGetRooms');
}

async function subset(client) {
  client.send('getPlayers', [client.account.playerId]);
  const response = await client.wait('onGetPlayers');
  assert.equal(response.data[0].playerId, client.account.playerId);
  assert.equal(client.closed, false);
}

function expandedNumbers(method, prefix = '', suffix = '') {
  return `{"method":"${method}","data":${prefix}[${Array(12000).fill('1e20').join(',')}]${suffix}}`;
}

test('canonical JSON expansion is rejected before room allocation or lobby fanout', async t => {
  const { server, url } = await startServer(t);
  const sender = await connect(t, url);
  const lobby = await connect(t, url);
  const raw = expandedNumbers('createRoom', '{"name":"Expansion","maxPlayers":4,"gameData":', '}');
  assert.ok(Buffer.byteLength(raw) < 65536);
  assert.ok(bytes(JSON.parse(raw)) > 262144);
  sender.ws.send(raw);
  assert.equal((await sender.wait('error')).data.code, 'payload_too_large');
  await sender.barrier();
  await lobby.barrier();
  assert.equal(server.stats().rooms, 0);
  assert.equal(server.stats().online, 2);
  sender.assertNo('onRoomEnter');
  lobby.assertNo('roomCreated');
  const room = await createRoom(sender);
  await enterRoom(lobby, room);
  sender.send('sendToRoom', 'healthy');
  assert.equal((await lobby.wait('messageFromPlayer')).data.msg, 'healthy');
});

test('canonical relay expansion rejects the sender without a peer broadcast', async t => {
  const { url } = await startServer(t);
  const sender = await connect(t, url);
  const peer = await connect(t, url);
  await enterRoom(peer, await createRoom(sender));
  const raw = expandedNumbers('sendToRoom');
  assert.ok(Buffer.byteLength(raw) < 65536);
  sender.ws.send(raw);
  assert.equal((await sender.wait('error')).data.code, 'payload_too_large');
  await sender.barrier();
  await peer.barrier();
  peer.assertNo('messageFromPlayer');
  sender.send('sendToRoom', 1);
  assert.equal((await peer.wait('messageFromPlayer')).data.msg, 1);
});

test('normalization never traverses unvalidated deeply nested envelope extensions', async t => {
  const { url } = await startServer(t);
  const client = await connect(t, url);
  const raw = '{"method":"getRooms","extension":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}';
  assert.ok(Buffer.byteLength(raw) < 65536);
  client.ws.send(raw);
  assert.equal((await client.wait('error')).data.code, 'invalid_message');
  await client.barrier();
});

test('relay envelope overhead is budgeted before fanout, not just the input bytes', async t => {
  const { server, url } = await startServer(t, { maxPayloadBytes: 4096, maxBufferedBytes: 512 });
  const sender = await connect(t, url);
  const peer = await connect(t, url);
  await enterRoom(peer, await createRoom(sender));
  const msg = 'x'.repeat(440);
  assert.ok(bytes({ method: 'sendToRoom', data: msg }) <= 502);
  assert.ok(bytes({ method: 'messageFromPlayer', data: { from: sender.account.playerId, msg } }) > 502);
  await expectError(sender, 'sendToRoom', msg, 'payload_too_large');
  await subset(sender);
  await subset(peer);
  peer.assertNo('messageFromPlayer');
  assert.equal(server.stats().online, 2);
});

test('room metadata is atomic and getRooms pages are byte-bounded including cursors', async t => {
  const { server, url } = await startServer(t);
  const reader = await connect(t, url);
  const owners = [];
  const rooms = [];
  for (let i = 0; i < 3; i++) {
    const owner = await connect(t, url);
    owners.push(owner);
    const room = await createRoom(owner, { gameData: 'x'.repeat(50000) });
    rooms.push(room);
    await reader.wait('roomCreated', data => data.roomId === room.roomId);
    owner.send('setRoomMeta', { previous: i });
    await owner.wait('onSetRoomMeta');
    await expectError(owner, 'setRoomMeta', 'y'.repeat(50000), 'payload_too_large');
    await owner.barrier();
    owner.assertNo('onSetRoomMeta');
  }
  // A room member must not see the failed metadata mutation either.
  await enterRoom(reader, rooms[0]);
  await expectError(owners[0], 'setRoomMeta', 'y'.repeat(50000), 'payload_too_large');
  await reader.barrier();
  reader.assertNo('onSetRoomMeta');
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const response = await page(reader, cursor === undefined ? null : { after: cursor });
    assert.ok(bytes(response) <= Math.min(65536, 262144 - 10));
    assert.ok(response.data.length > 0);
    assert.ok(response.nextCursor === null || typeof response.nextCursor === 'string');
    seen.push(...response.data);
    cursor = response.nextCursor;
    assert.ok(++pages <= rooms.length, 'Pagination must make progress');
  } while (cursor !== null);
  assert.ok(pages > 1, 'Aggregate must be split into multiple pages');
  assert.deepEqual(seen.map(room => room.roomId), rooms.map(room => room.roomId).sort());
  assert.equal(new Set(seen.map(room => room.roomId)).size, rooms.length);
  for (const room of seen) {
    const index = rooms.findIndex(original => original.roomId === room.roomId);
    assert.deepEqual(room.metaData, { previous: index });
  }
  assert.equal(server.stats().online, 4);
  await expectError(reader, 'getRooms', { after: 'not-a-uuid' }, 'invalid_message');
  await expectError(reader, 'getRooms', { after: 42 }, 'invalid_message');
  // Omitted, null and an empty options object all start at the first room.
  for (const data of [undefined, null, {}]) {
    assert.equal((await page(reader, data)).data[0].roomId, seen[0].roomId);
  }
  const firstPage = await page(reader);
  assert.notEqual(firstPage.nextCursor, null);
  const deletedCursor = firstPage.nextCursor;
  const index = rooms.findIndex(room => room.roomId === deletedCursor);
  // Ensure the cursor room is actually disposed, even if the reader joined it.
  reader.send('leaveRoom');
  await reader.barrier();
  owners[index].send('leaveRoom');
  await owners[index].barrier();
  await eventually(() => server.stats().rooms === 2, 'cursor room deletion');
  const continuation = await page(reader, { after: deletedCursor });
  assert.ok(continuation.data.length > 0);
  assert.ok(continuation.data.every(room => room.roomId > deletedCursor));
  assert.equal(continuation.data[0].roomId, seen.find(room => room.roomId > deletedCursor).roomId);
});

test('room admission reserves the full maxPlayers DTO rather than only current membership', async t => {
  const { server, url } = await startServer(t, { maxPayloadBytes: 4096, maxBufferedBytes: 4096 });
  const sender = await connect(t, url);
  const observer = await connect(t, url);
  await expectError(sender, 'createRoom', {
    name: 'Reserved capacity', maxPlayers: 16, gameData: 'x'.repeat(3400),
  }, 'payload_too_large');
  await subset(sender);
  await subset(observer);
  assert.equal(server.stats().rooms, 0);
  observer.assertNo('roomCreated');
  const room = await createRoom(sender, { maxPlayers: 1, gameData: 'x'.repeat(3400) });
  assert.equal(room.maxPlayers, 1);
  assert.ok(bytes(await page(observer)) <= 4086);
  sender.send('leaveRoom');
  await subset(sender);
  const reserved = await createRoom(sender, { maxPlayers: 16, gameData: 'x'.repeat(3000) });
  await enterRoom(observer, reserved);
  await expectError(sender, 'setRoomMeta', 'y'.repeat(300), 'payload_too_large');
  await subset(sender);
  await subset(observer);
  observer.assertNo('onSetRoomMeta');
  assert.equal((await page(observer)).data[0].metaData, null);
});

test('oversized getPlayers aggregate returns response_too_large while subsets survive', async t => {
  const { server, url } = await startServer(t, { maxPayloadBytes: 4096, maxBufferedBytes: 512 });
  const clients = [];
  for (let i = 0; i < 4; i++) clients.push(await connect(t, url, { name: 'n'.repeat(64) }));
  await expectError(clients[0], 'getPlayers', null, 'response_too_large');
  for (const client of clients) await subset(client);
  assert.equal(server.stats().online, clients.length);
  clients[0].assertNo('onGetPlayers');
});

test('normal RFC ping gets exactly one echo; mixed data, ping and pong share one quota', async t => {
  const { server, url } = await startServer(t, { maxMessagesPerSecond: 12 });
  const healthy = await connect(t, url);
  const abusive = await connect(t, url, {}, { autoPong: false });
  const echoes = [];
  abusive.ws.on('pong', data => echoes.push(data.toString()));
  abusive.ws.ping('normal');
  await eventually(() => echoes.length === 1, 'one normal control echo');
  assert.deepEqual(echoes, ['normal']);
  // Authentication + normal ping + four data + four unsolicited pong + two
  // accepted ping = 12. The next ping must be terminated BEFORE any echo.
  for (let i = 0; i < 4; i++) abusive.send('getRooms');
  for (let i = 0; i < 4; i++) abusive.ws.pong(`unsolicited-${i}`);
  abusive.ws.ping('allowed-1');
  abusive.ws.ping('allowed-2');
  abusive.ws.ping('over-limit');
  await waitClosed(abusive, 1000);
  assert.deepEqual(echoes, ['normal', 'allowed-1', 'allowed-2']);
  await eventually(() => server.stats().online === 1, 'mixed-control offender cleanup');
  await healthy.barrier();
});

test('control quotas apply before authentication and to unsolicited pong floods', async t => {
  for (const authenticated of [false, true]) {
    const { server, url } = await startServer(t, { maxMessagesPerSecond: 8, authTimeoutMs: 10000 });
    const healthy = await connect(t, url);
    const abusive = authenticated ? await connect(t, url) : rawClient(t, url, { autoPong: false });
    await abusive.opened;
    let echoes = 0;
    abusive.ws.on('pong', () => echoes++);
    for (let i = 0; i < 16; i++) {
      if (authenticated) abusive.ws.pong(Buffer.alloc(125, i));
      else abusive.ws.ping(Buffer.alloc(125, i));
    }
    await waitClosed(abusive, 1000);
    assert.equal(echoes, authenticated ? 0 : 8);
    await eventually(() => server.stats().online === 1 && server.stats().pendingConnections === 0, 'control offender cleanup');
    assert.equal(server.stats().accounts, authenticated ? 2 : 1);
    await healthy.barrier();
  }
});

test('paused-reader ping flood stays within the control quota and outbound queue budget', async t => {
  const { server, url } = await startServer(t);
  const healthy = await connect(t, url);
  const abusive = await connect(t, url, {}, { autoPong: false });
  // Observe the real server-side ws pong calls, without reading Server internals.
  // Restore even on failure; node:test runs this file's top-level tests serially.
  const original = WebSocket.prototype.pong;
  let replies = 0;
  let maximumQueued = 0;
  WebSocket.prototype.pong = function (data, ...args) {
    if (this._isServer) {
      replies++;
      maximumQueued = Math.max(maximumQueued, this.bufferedAmount + Buffer.byteLength(data) + 2);
    }
    return original.call(this, data, ...args);
  };
  abusive.ws.pause();
  try {
    for (let i = 0; i < 1000; i++) abusive.ws.ping(Buffer.alloc(125, i % 256));
    await eventually(() => server.stats().online === 1, 'paused ping offender termination', 1000);
  } finally {
    abusive.ws.resume();
    WebSocket.prototype.pong = original;
  }
  await waitClosed(abusive, 1000);
  assert.ok(replies > 0 && replies <= 119, `Unexpected control reply count: ${replies}`);
  assert.ok(maximumQueued <= 262144, `Control queue exceeded budget: ${maximumQueued}`);
  await healthy.barrier();
});

test('manual control replies enforce a saturated byte queue independently of a higher rate quota', async t => {
  const { server, url } = await startServer(t, { maxBufferedBytes: 512, maxMessagesPerSecond: 20000 });
  const healthy = await connect(t, url);
  const slow = await connect(t, url, {}, { autoPong: false });
  const original = WebSocket.prototype.pong;
  let heldSocket;
  let replies = 0;
  let maximumQueued = 0;
  WebSocket.prototype.pong = function (data, ...args) {
    if (this._isServer) {
      // Hold the real writable queue; do not mock bufferedAmount. A paused
      // reader alone need not fill the OS TCP buffers with this bounded input.
      if (!heldSocket) { heldSocket = this._socket; heldSocket.cork(); }
      replies++;
      maximumQueued = Math.max(maximumQueued, this.bufferedAmount + Buffer.byteLength(data) + 2);
    }
    return original.call(this, data, ...args);
  };
  slow.ws.pause();
  try {
    // At most 1.25 MB of input, below the configured rate quota. Corking makes
    // queue saturation deterministic across Windows/Linux TCP buffer sizes.
    for (let i = 0; i < 10000; i++) slow.ws.ping(Buffer.alloc(125, i % 256));
    await eventually(() => server.stats().online === 1, 'control byte-queue enforcement', 2500);
  } finally {
    if (heldSocket && !heldSocket.destroyed) heldSocket.uncork();
    slow.ws.resume();
    WebSocket.prototype.pong = original;
  }
  await waitClosed(slow);
  assert.equal(replies, 4, 'Four 127-byte frames fit; the fifth must not be queued');
  assert.ok(maximumQueued <= 512, `Control queue exceeded budget: ${maximumQueued}`);
  await healthy.barrier();
});
