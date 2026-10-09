'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  eventually, startServer, rawClient, connect, createRoom, enterRoom, expectError, waitClosed, within, rawTcp,
} = require('./helpers.cjs');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.setTimeout(1000, () => request.destroy(new Error('HTTP timeout')));
    request.on('error', reject);
  });
}

async function rooms(client) {
  client.send('getRooms');
  return (await client.wait('onGetRooms')).data;
}

async function player(client, id) {
  client.send('getPlayers', [id]);
  return (await client.wait('onGetPlayers')).data[0];
}

async function noRelay(client, method, predicate = () => true) {
  await client.barrier();
  client.assertNo(method, predicate);
}

test('guest authentication, room DTO, chat, JSON primitives, targeted and raw binary relay', async t => {
  const { server, url } = await startServer(t);
  const owner = await connect(t, url, { name: 'Owner' });
  const peer = await connect(t, url);
  assert.match(owner.account.playerId, uuid);
  assert.ok(typeof owner.account.password === 'string' && owner.account.password.length >= 16);
  const room = await createRoom(owner);
  assert.match(room.roomId, uuid);
  assert.equal(room.hasPassword, false);
  assert.equal(room.ownerId, owner.account.playerId);
  assert.deepEqual(room.players, [owner.account.playerId]);
  await enterRoom(peer, room);
  owner.send('sendChatMsg', 'hello');
  assert.deepEqual((await peer.wait('chatMsg')).data, { text: 'hello', from: owner.account.playerId });
  owner.send('sendToRoom', null);
  assert.deepEqual((await peer.wait('messageFromPlayer')).data, { from: owner.account.playerId, msg: null });
  owner.send('sendTo', { to: [peer.account.playerId], msg: 42 });
  assert.equal((await peer.wait('messageFromPlayer')).data.msg, 42);
  const bytes = Buffer.from([0, 1, 255, 128]);
  owner.ws.send(bytes);
  assert.deepEqual((await peer.wait('binary')).data, bytes);
  await noRelay(owner, 'binary');
  assert.deepEqual(server.stats(), { accounts: 2, online: 2, rooms: 1, pendingConnections: 0 });
});

test('credentials are required as a complete valid pair; failures do not allocate accounts', async t => {
  const { server, url } = await startServer(t);
  const account = (await connect(t, url)).account;
  for (const credentials of [
    { playerId: account.playerId, password: 'incorrect' },
    { playerId: randomUUID(), password: 'chosen-secret' },
    { playerId: account.playerId },
    { password: 'secret-only' },
  ]) {
    const attacker = rawClient(t, url);
    await attacker.opened;
    attacker.send('authenticate', credentials);
    await attacker.wait('wrongPassword');
    await waitClosed(attacker);
    attacker.assertNo('accountCreated');
    assert.equal(server.stats().accounts, 1);
  }
});

test('query credentials and untrusted Origins are rejected; known Origin and native clients work', async t => {
  const { server, url } = await startServer(t);
  for (const [suffix, origin] of [
    ['?name=secret&playerId=secret&password=secret', undefined],
    ['', 'https://attacker.example'], ['', 'null'],
  ]) {
    const client = rawClient(t, url + suffix, origin ? { origin } : undefined);
    await waitClosed(client);
    client.assertNo('accountCreated');
  }
  assert.equal(server.stats().accounts, 0);
  await connect(t, url, {}, { origin: 'http://localhost:8081' });
  await connect(t, url);
  const restricted = await startServer(t, { allowedOrigins: ['https://game.example'], allowNoOrigin: false });
  await waitClosed(rawClient(t, restricted.url));
  await connect(t, restricted.url, {}, { origin: 'https://game.example' });
});

test('authentication timeout and repeated authentication are enforced', async t => {
  const { server, url } = await startServer(t, { authTimeoutMs: 150 });
  const pending = rawClient(t, url);
  await pending.opened;
  assert.equal(server.stats().pendingConnections, 1);
  await waitClosed(pending);
  assert.equal(server.stats().accounts, 0);
  const client = await connect(t, url);
  await expectError(client, 'authenticate', {}, 'invalid_message');
  await client.barrier();
  assert.equal(server.stats().accounts, 1);
});

test('duplicate reconnect fences the old socket close and retains the current session', async t => {
  const { server, url } = await startServer(t);
  const old = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(old);
  await enterRoom(peer, room);
  const replacement = await connect(t, url, old.account);
  await waitClosed(old);
  await replacement.barrier();
  assert.equal(server.stats().online, 2);
  assert.ok((await rooms(peer)).find(item => item.roomId === room.roomId).players.includes(old.account.playerId));
  replacement.send('sendToRoom', { current: true });
  assert.equal((await peer.wait('messageFromPlayer')).data.msg.current, true);
  replacement.assertNo('accountCreated');
});

test('creating or entering another room while active cannot allocate ghost rooms', async t => {
  const { server, url } = await startServer(t);
  const a = await connect(t, url);
  const b = await connect(t, url);
  const first = await createRoom(a);
  const second = await createRoom(b);
  await expectError(a, 'createRoom', { name: 'Ghost', maxPlayers: 2 }, 'in_other_room');
  await expectError(a, 'enterRoom', { roomId: second.roomId }, 'in_other_room');
  await expectError(a, 'enterRoom', { roomId: first.roomId }, 'already_in_room');
  assert.equal(server.stats().rooms, 2);
  assert.deepEqual(new Set((await rooms(a)).map(room => room.roomId)), new Set([first.roomId, second.roomId]));
});

test('room passwords, capacity and owner permissions have stable errors', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const extra = await connect(t, url);
  const room = await createRoom(owner, { password: 'room-secret', maxPlayers: 2 });
  assert.equal(room.hasPassword, true);
  assert.equal(Object.hasOwn(room, 'password'), false);
  await expectError(peer, 'enterRoom', { roomId: room.roomId }, 'wrong_password');
  await enterRoom(peer, room, 'room-secret');
  await expectError(extra, 'enterRoom', { roomId: room.roomId, password: 'room-secret' }, 'full_room');
  for (const [method, data] of [
    ['startGame', {}], ['setRoomMeta', {}], ['shareGameState', { gamestate: {} }],
  ]) await expectError(peer, method, data, 'not_room_owner');
  owner.send('setRoomMeta', { level: 2 });
  assert.deepEqual((await peer.wait('onSetRoomMeta')).data, { level: 2 });
  owner.send('startGame', { round: 1 });
  await peer.wait('gameStarted');
  await expectError(owner, 'startGame', {}, 'already_started');
});

test('entry timestamps precede notifications; players sort ascending, null last, with deterministic ties', async t => {
  const { url } = await startServer(t);
  const lobby = await connect(t, url);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  const entered = (await owner.wait('playerEnter')).data;
  assert.ok(Number.isFinite(entered.roomEntryTimestamp));
  const players = await lobby.barrier();
  const sorted = [...players].sort((a, b) => {
    if (a.roomEntryTimestamp === null && b.roomEntryTimestamp !== null) return 1;
    if (b.roomEntryTimestamp === null && a.roomEntryTimestamp !== null) return -1;
    return (a.roomEntryTimestamp ?? 0) - (b.roomEntryTimestamp ?? 0) || a.playerId.localeCompare(b.playerId);
  });
  assert.deepEqual(players, sorted);
  assert.equal(players.at(-1).playerId, lobby.account.playerId);
  for (const dto of players) {
    assert.equal(Object.hasOwn(dto, 'password'), false);
    assert.ok(uuid.test(dto.playerId));
  }
  lobby.send('getPlayers', [peer.account.playerId]);
  assert.deepEqual((await lobby.wait('onGetPlayers')).data.map(dto => dto.playerId), [peer.account.playerId]);
});

test('disconnect reserves started-room eligibility, explicit leave revokes it, host stays active', async t => {
  const { server, url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const outsider = await connect(t, url);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  owner.send('startGame', {});
  await peer.wait('gameStarted');
  await owner.close();
  assert.equal((await peer.wait('playerDisconnected')).data, owner.account.playerId);
  assert.equal((await peer.wait('newRoomOwner')).data, peer.account.playerId);
  assert.deepEqual((await rooms(peer))[0].players, [peer.account.playerId]);
  const returning = await connect(t, url, owner.account);
  await enterRoom(returning, room);
  const entered = (await peer.wait('playerEnter')).data;
  assert.ok(Number.isFinite(entered.roomEntryTimestamp));
  await expectError(outsider, 'enterRoom', { roomId: room.roomId }, 'game_started_without_you');
  returning.send('leaveRoom');
  assert.equal((await peer.wait('playerLeft')).data, owner.account.playerId);
  await expectError(returning, 'enterRoom', { roomId: room.roomId }, 'game_started_without_you');
  await peer.close();
  await eventually(() => server.stats().rooms === 0, 'last-peer room disposal');
  await expectError(returning, 'enterRoom', { roomId: room.roomId }, 'no_room');
});

test('explicit owner leave hands off to an active peer; switching rooms isolates all transports', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url);
  const oldPeer = await connect(t, url);
  const newPeer = await connect(t, url);
  const first = await createRoom(owner);
  await enterRoom(oldPeer, first);
  const second = await createRoom(newPeer);
  owner.send('leaveRoom');
  await oldPeer.wait('playerLeft');
  assert.equal((await oldPeer.wait('newRoomOwner')).data, oldPeer.account.playerId);
  await enterRoom(owner, second);
  oldPeer.send('sendToRoom', { stale: 'broadcast' });
  oldPeer.send('sendTo', { to: [owner.account.playerId], msg: { stale: 'target' } });
  oldPeer.send('shareGameState', { to: [owner.account.playerId], gamestate: { stale: true } });
  oldPeer.ws.send(Buffer.from('old-room'));
  await oldPeer.barrier();
  await noRelay(owner, 'messageFromPlayer', data => data.msg?.stale);
  await noRelay(owner, 'newGameState');
  await noRelay(owner, 'binary');
  owner.send('sendToRoom', 'new-room');
  assert.equal((await newPeer.wait('messageFromPlayer')).data.msg, 'new-room');
  await noRelay(oldPeer, 'messageFromPlayer', data => data.msg === 'new-room');
  owner.send('requestGameState');
  assert.equal((await newPeer.wait('gameStateRequested')).data.playerId, owner.account.playerId);
  await noRelay(oldPeer, 'gameStateRequested');
});

test('started-room reservation cannot override active membership in another room', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  owner.send('startGame', {});
  await peer.wait('gameStarted');
  await peer.close();
  await owner.wait('playerDisconnected');
  const replacement = await connect(t, url, peer.account);
  const other = await createRoom(replacement);
  await expectError(replacement, 'enterRoom', { roomId: room.roomId }, 'in_other_room');
  assert.deepEqual((await rooms(replacement)).find(item => item.roomId === other.roomId).players, [peer.account.playerId]);
  owner.send('sendTo', { to: [peer.account.playerId], msg: 'reserved-not-active' });
  owner.ws.send(Buffer.from('reserved-not-active'));
  await owner.barrier();
  await noRelay(replacement, 'messageFromPlayer');
  await noRelay(replacement, 'binary');
});

test('offline public subsets are retained only until TTL; expired credentials cannot recreate IDs', async t => {
  const { server, url } = await startServer(t, { accountTtlMs: 500 });
  const observer = await connect(t, url);
  const offline = await connect(t, url);
  await offline.close();
  await eventually(() => server.stats().online === 1, 'offline transition');
  assert.deepEqual((await observer.barrier()).map(dto => dto.playerId), [observer.account.playerId]);
  const retained = await player(observer, offline.account.playerId);
  assert.equal(retained.playerId, offline.account.playerId);
  assert.equal(Object.hasOwn(retained, 'password'), false);
  await eventually(() => server.stats().accounts === 1, 'account TTL');
  assert.equal(await player(observer, offline.account.playerId), undefined);
  const expired = rawClient(t, url);
  await expired.opened;
  expired.send('authenticate', offline.account);
  await expired.wait('wrongPassword');
  await waitClosed(expired);
  assert.equal(server.stats().accounts, 1);
});

test('malformed envelopes, field types and prototype method names return invalid_message and survive', async t => {
  const { url } = await startServer(t);
  const client = await connect(t, url);
  const invalid = [
    '{', 'null', '[]', '42', '{}',
    JSON.stringify({ method: 'toString' }), JSON.stringify({ method: 'constructor' }),
    JSON.stringify({ method: '__proto__' }), JSON.stringify({ method: 'hasOwnProperty' }),
    JSON.stringify({ method: 5 }), JSON.stringify({ method: 'missing-method' }),
    JSON.stringify({ method: 'changeName', data: 42 }),
    JSON.stringify({ method: 'changeName', data: '' }),
    JSON.stringify({ method: 'changeName', data: 'x'.repeat(65) }),
    JSON.stringify({ method: 'createRoom', data: null }),
    JSON.stringify({ method: 'createRoom', data: { name: 'X', maxPlayers: 1.5 } }),
    JSON.stringify({ method: 'createRoom', data: { name: 'X', maxPlayers: 0 } }),
    JSON.stringify({ method: 'createRoom', data: { name: 'X', maxPlayers: 2, password: 'x'.repeat(129) } }),
    JSON.stringify({ method: 'enterRoom', data: { roomId: 'not-a-uuid' } }),
    JSON.stringify({ method: 'sendChatMsg', data: 'x'.repeat(2049) }),
    JSON.stringify({ method: 'sendTo', data: { to: [client.account.playerId, client.account.playerId], msg: {} } }),
    JSON.stringify({ method: 'getPlayers', data: 'not-an-array' }),
    JSON.stringify({ method: 'Pong', data: 'not-a-number' }),
  ];
  for (const frame of invalid) {
    client.ws.send(frame);
    assert.equal((await client.wait('error')).data.code, 'invalid_message', frame.slice(0, 100));
    assert.ok(Array.isArray(await client.barrier()));
  }
});

test('bounded account and room quotas reject before allocation', async t => {
  const { server, url } = await startServer(t, { maxAccounts: 2, maxRooms: 1, maxRoomPlayers: 2 });
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const extra = rawClient(t, url);
  await extra.opened;
  extra.send('authenticate', {});
  assert.equal((await extra.wait('error')).data.code, 'limit_exceeded');
  extra.assertNo('accountCreated');
  assert.equal(server.stats().accounts, 2);
  await expectError(owner, 'createRoom', { name: 'Too large', maxPlayers: 3 }, 'invalid_message');
  await createRoom(owner, { maxPlayers: 2 });
  await expectError(peer, 'createRoom', { name: 'Too many', maxPlayers: 2 }, 'limit_exceeded');
  assert.equal(server.stats().rooms, 1);
  owner.send('leaveRoom');
  await owner.barrier();
  await eventually(() => server.stats().rooms === 0, 'room capacity release');
  await createRoom(peer, { maxPlayers: 2 });
});

test('pending sockets count against global and per-IP connection limits', async t => {
  for (const options of [{ maxConnections: 1 }, { maxConnectionsPerIp: 1 }]) {
    const { server, url } = await startServer(t, options);
    const pending = rawClient(t, url);
    await pending.opened;
    await waitClosed(rawClient(t, url));
    assert.equal(server.stats().pendingConnections, 1);
    assert.equal(server.stats().accounts, 0);
    pending.send('authenticate', {});
    await pending.wait('accountCreated');
    await pending.wait('onConnected');
    await pending.close();
    await eventually(() => server.stats().online === 0, 'connection release');
    await connect(t, url);
  }
});

test('per-IP connection attempt quota cannot be bypassed with forwarded headers', async t => {
  const { server, url } = await startServer(t, { maxConnectionsPerMinute: 2 });
  const first = await connect(t, url);
  await first.close();
  const second = await connect(t, url);
  await second.close();
  const third = rawClient(t, url, { headers: { 'X-Forwarded-For': '192.0.2.123' } });
  await waitClosed(third);
  assert.equal(server.stats().accounts, 2);
});

test('oversized text and binary frames are closed without damaging healthy peers', async t => {
  const { server, url } = await startServer(t, { maxPayloadBytes: 512 });
  const observer = await connect(t, url);
  for (const binary of [false, true]) {
    const abusive = await connect(t, url);
    abusive.ws.send(binary ? Buffer.alloc(513) : 'x'.repeat(513));
    await waitClosed(abusive);
  }
  assert.ok(Array.isArray(await observer.barrier()));
  await eventually(() => server.stats().online === 1, 'oversized socket cleanup');
});

test('message-rate quota bounds short text and binary bursts', async t => {
  for (const binary of [false, true]) {
    const { url } = await startServer(t, { maxMessagesPerSecond: 4 });
    const abusive = await connect(t, url);
    for (let i = 0; i < 8; i++) {
      if (binary) abusive.ws.send(Buffer.from([i]));
      else abusive.send('getRooms');
    }
    const outcome = await Promise.race([
      abusive.wait('error', data => data.code === 'limit_exceeded').then(() => 'error').catch(error => {
        if (abusive.closed) return 'closed';
        throw error;
      }),
      waitClosed(abusive).then(() => 'closed'),
    ]);
    assert.ok(['error', 'closed'].includes(outcome));
    const healthy = await connect(t, url);
    assert.ok(Array.isArray(await healthy.barrier()));
  }
});

test('heartbeat accepts only an outstanding numeric timestamp once, never forged or replayed RTT', async t => {
  const { url } = await startServer(t, { heartbeatIntervalMs: 500, idleTimeoutMs: 2000 });
  const client = await connect(t, url);
  const initial = (await player(client, client.account.playerId)).rtt;
  client.send('Pong', Date.now() + 1000000);
  assert.equal((await player(client, client.account.playerId)).rtt, initial);
  const timestamp = (await client.wait('Ping')).data;
  assert.ok(Number.isFinite(timestamp));
  client.send('Pong', timestamp);
  const rtt = (await player(client, client.account.playerId)).rtt;
  assert.ok(Number.isFinite(rtt) && rtt >= 0);
  await eventually(() => Date.now() >= timestamp + rtt + 20, 'distinct replay elapsed time');
  client.send('Pong', timestamp);
  client.send('Pong', -1);
  assert.equal((await player(client, client.account.playerId)).rtt, rtt);
});

test('idle sockets close and dispose the last active room', async t => {
  const { server, url } = await startServer(t, { heartbeatIntervalMs: 50, idleTimeoutMs: 300 });
  const client = await connect(t, url);
  await createRoom(client);
  await waitClosed(client);
  await eventually(() => server.stats().online === 0 && server.stats().rooms === 0, 'idle cleanup');
});

test('shutdown with delayed mode closes clients without post-stop relay', async t => {
  const { server, url } = await startServer(t, { devMode: true, sendDelayMs: 80 });
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  owner.send('sendToRoom', 'pending-shutdown');
  owner.ws.send(Buffer.from('pending-shutdown'));
  await server.stop();
  await waitClosed(owner);
  await waitClosed(peer);
  peer.assertNo('messageFromPlayer', data => data.msg === 'pending-shutdown');
  peer.assertNo('binary');
  await server.stop();
});

test('dev-mode logger never receives credentials, names, URL query or application payloads', async t => {
  const logs = [];
  const { url } = await startServer(t, { devMode: true, logger: text => logs.push(text) });
  const owner = await connect(t, url, { name: 'CONFIDENTIAL_PLAYER_NAME' });
  const peer = await connect(t, url);
  const room = await createRoom(owner, { password: 'CONFIDENTIAL_ROOM_PASSWORD', gameData: { secret: 'CONFIDENTIAL_GAME_DATA' } });
  await enterRoom(peer, room, 'CONFIDENTIAL_ROOM_PASSWORD');
  owner.send('sendChatMsg', 'CONFIDENTIAL_CHAT_TEXT');
  await peer.wait('chatMsg');
  owner.send('setRoomMeta', { secret: 'CONFIDENTIAL_METADATA' });
  await peer.wait('onSetRoomMeta');
  owner.send('shareGameState', { gamestate: { secret: 'CONFIDENTIAL_GAME_STATE' } });
  await peer.wait('newGameState');
  const query = rawClient(t, url + '?password=CONFIDENTIAL_QUERY_PASSWORD');
  await waitClosed(query);
  await owner.barrier();
  const output = logs.join('\n');
  for (const secret of [
    owner.account.playerId, owner.account.password, peer.account.password,
    'CONFIDENTIAL_PLAYER_NAME', 'CONFIDENTIAL_ROOM_PASSWORD', 'CONFIDENTIAL_GAME_DATA',
    'CONFIDENTIAL_CHAT_TEXT', 'CONFIDENTIAL_METADATA', 'CONFIDENTIAL_GAME_STATE', 'CONFIDENTIAL_QUERY_PASSWORD',
  ]) assert.equal(output.includes(secret), false, 'Logger exposed confidential data');
});

test('HTTP health, independent servers, idempotent shutdown and startup bind rejection', async t => {
  const first = await startServer(t);
  const second = await startServer(t);
  const health = await get(first.http + '/healthz');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');
  assert.equal((await get(first.http + '/not-found')).status, 404);
  const client = await connect(t, first.url);
  const pending = rawClient(t, first.url);
  await pending.opened;
  await createRoom(client);
  const { Server } = require('../dist/Server.js');
  const occupied = new Server({ host: '127.0.0.1', port: first.server.address().port, logger: () => {} });
  t.after(() => occupied.stop());
  await assert.rejects(occupied.start(), error => error.code === 'EADDRINUSE');
  await Promise.all([first.server.stop(), first.server.stop()]);
  await waitClosed(client);
  await waitClosed(pending);
  assert.equal(first.server.address(), null);
  assert.equal(first.server.stats().online, 0);
  assert.equal(first.server.stats().rooms, 0);
  assert.equal(first.server.stats().pendingConnections, 0);
  await first.server.stop();
  assert.equal((await get(second.http + '/healthz')).status, 200);
  await assert.rejects(get(first.http + '/healthz'));
});

function cli(t, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '../dist/index.js')], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { output = (output + chunk).slice(-8192); });
  }
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, exited, output: () => output };
}

async function childExit(processInfo) {
  let timer;
  try {
    return await Promise.race([
      processInfo.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLI did not exit')), 2500); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('CLI exits nonzero for invalid configuration and occupied port', async t => {
  const invalid = cli(t, { PORT: 'not-a-number' });
  const invalidExit = await childExit(invalid);
  assert.equal(invalidExit.signal, null);
  assert.ok(Number.isInteger(invalidExit.code) && invalidExit.code > 0);
  const { server } = await startServer(t);
  const occupied = cli(t, { HOST: '127.0.0.1', PORT: String(server.address().port) });
  const occupiedExit = await childExit(occupied);
  assert.equal(occupiedExit.signal, null);
  assert.ok(Number.isInteger(occupiedExit.code) && occupiedExit.code > 0);
});

test('CLI handles SIGTERM gracefully and releases timers', { skip: process.platform === 'win32' ? 'Windows child.kill does not deliver POSIX SIGTERM handlers' : false }, async t => {
  // Reserve an ephemeral port with the public API, then release it for the CLI.
  const reservation = await startServer(t);
  const port = reservation.server.address().port;
  await reservation.server.stop();
  const processInfo = cli(t, { HOST: '127.0.0.1', PORT: String(port), SHUTDOWN_TIMEOUT_MS: '100' });
  await eventually(async () => {
    if (processInfo.child.exitCode !== null) assert.fail(`CLI exited before health: ${processInfo.output()}`);
    try { return (await get(`http://127.0.0.1:${port}/healthz`)).status === 200; }
    catch { return false; }
  }, 'CLI health readiness');
  const client = await connect(t, `ws://127.0.0.1:${port}/`);
  await createRoom(client);
  processInfo.child.kill('SIGTERM');
  const exit = await childExit(processInfo);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  await waitClosed(client);
});

test('active-session replacement sends ordered room snapshot without entry events or timestamp changes', async t => {
  for (const started of [false, true]) {
    const { server, url } = await startServer(t);
    const owner = await connect(t, url, { name: 'Snapshot owner' });
    const peer = await connect(t, url);
    const room = await createRoom(owner);
    await enterRoom(peer, room);
    await owner.wait('playerEnter');
    owner.send('setRoomMeta', { level: 7 });
    await peer.wait('onSetRoomMeta');
    if (started) {
      owner.send('startGame', { round: 2 });
      await peer.wait('gameStarted');
    }
    const timestamp = (await player(peer, owner.account.playerId)).roomEntryTimestamp;
    assert.ok(Number.isFinite(timestamp));
    const replacement = rawClient(t, url);
    const received = [];
    replacement.ws.on('message', (bytes, binary) => {
      if (!binary) received.push(JSON.parse(bytes.toString()).method);
    });
    await replacement.opened;
    replacement.send('authenticate', owner.account);
    await replacement.wait('onConnected');
    const snapshot = (await replacement.wait('onRoomEnter')).data;
    assert.deepEqual(received.slice(0, 2), ['onConnected', 'onRoomEnter']);
    assert.equal(snapshot.roomId, room.roomId);
    assert.equal(snapshot.ownerId, owner.account.playerId);
    assert.equal(snapshot.gameStarted, started);
    assert.deepEqual(snapshot.metaData, { level: 7 });
    assert.deepEqual(snapshot.players, [owner.account.playerId, peer.account.playerId]);
    await waitClosed(owner);
    assert.equal((await player(peer, owner.account.playerId)).roomEntryTimestamp, timestamp);
    peer.assertNo('playerEnter');
    peer.assertNo('playerLeft');
    peer.assertNo('playerDisconnected');
    peer.assertNo('newRoomOwner');
    assert.equal(server.stats().online, 2);
    replacement.assertNo('accountCreated');
  }
});

test('stop immediately after start rejects startup and settles with no listening address', async t => {
  const { Server } = require('../dist/Server.js');
  const server = new Server({ host: '127.0.0.1', port: 0, shutdownTimeoutMs: 100, logger: () => {} });
  t.after(() => server.stop());
  const startup = server.start();
  // Attach the rejection handler before cancellation can reject the startup promise.
  const rejected = assert.rejects(startup, /stop/i);
  const stopping = server.stop();
  await within(Promise.all([rejected, stopping]), 'startup cancellation', 600);
  assert.equal(server.address(), null);
  await within(server.stop(), 'repeated stop', 600);
  assert.equal(server.stats().online, 0);
  assert.equal(server.stats().pendingConnections, 0);
});

test('stop before start is idempotent and cannot subsequently open a listener', async t => {
  const { Server } = require('../dist/Server.js');
  const server = new Server({ host: '127.0.0.1', port: 0, logger: () => {} });
  t.after(() => server.stop());
  await within(Promise.all([server.stop(), server.stop()]), 'stop before start', 600);
  await within(server.stop(), 'idempotent pre-start stop', 600);
  assert.equal(server.address(), null);
  await assert.rejects(server.start(), /stop/i);
  assert.equal(server.address(), null);
});

test('shutdown bounds both silent TCP and incomplete HTTP transports', async t => {
  const { server, url } = await startServer(t, { shutdownTimeoutMs: 100, authTimeoutMs: 10000 });
  const silent = await rawTcp(t, url);
  const partial = await rawTcp(t, url);
  partial.socket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Incomplete: ');
  // A completed HTTP request proves the listener has processed accepted connections,
  // without completing the two transports under test.
  const httpUrl = url.replace('ws:', 'http:');
  assert.equal((await get(httpUrl + 'healthz')).status, 200);
  await within(Promise.all([server.stop(), silent.closePromise, partial.closePromise]), 'raw transport shutdown', 600);
  assert.equal(server.address(), null);
  assert.equal(server.stats().pendingConnections, 0);
});

test('rejected raw WebSocket upgrades close TCP promptly and release admission capacity', async t => {
  const { server, url } = await startServer(t, { maxConnections: 1, maxConnectionsPerIp: 1, authTimeoutMs: 10000 });
  for (let i = 0; i < 3; i++) {
    const rejected = await rawTcp(t, url);
    rejected.socket.write([
      'GET / HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Origin: https://untrusted.example', '', '',
    ].join('\r\n'));
    await within(rejected.closePromise, 'rejected upgrade TCP closure', 600);
    assert.match(rejected.response, /^HTTP\/1\.1 403 /);
  }
  assert.equal(server.stats().pendingConnections, 0);
  assert.equal(server.stats().accounts, 0);
  const accepted = await connect(t, url);
  assert.ok(Array.isArray(await accepted.barrier()));
});

test('per-IP admission includes raw TCP before an HTTP or WebSocket upgrade', async t => {
  const { server, url } = await startServer(t, { maxConnectionsPerIp: 1, maxConnections: 8, authTimeoutMs: 10000 });
  const held = await rawTcp(t, url);
  held.socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  const extraRaw = await rawTcp(t, url);
  await within(extraRaw.closePromise, 'per-IP raw TCP rejection', 600);
  const extraWs = rawClient(t, url, { headers: { 'X-Forwarded-For': '192.0.2.42' } });
  await waitClosed(extraWs, 600);
  assert.equal(server.stats().accounts, 0);
  assert.equal(server.stats().pendingConnections, 0);
  // Graceful EOF forces the server to process the partial request and close its
  // end before we retry admission; local destroy alone would race remote cleanup.
  held.socket.end();
  await within(held.closePromise, 'raw TCP release', 600);
  const accepted = await connect(t, url);
  await accepted.barrier();
});

test('one outbound message over maxBufferedBytes closes its recipient without a flood', async t => {
  for (const binary of [false, true]) {
    const { server, url } = await startServer(t, { maxBufferedBytes: 512, maxPayloadBytes: 4096 });
    const sender = await connect(t, url);
    const recipient = await connect(t, url);
    const room = await createRoom(sender);
    await enterRoom(recipient, room);
    await sender.wait('playerEnter');
    if (binary) sender.ws.send(Buffer.alloc(1024, 1));
    else sender.send('sendTo', { to: [recipient.account.playerId], msg: 'x'.repeat(1024) });
    await waitClosed(recipient, 600);
    recipient.assertNo(binary ? 'binary' : 'messageFromPlayer');
    assert.equal((await sender.wait('playerDisconnected')).data, recipient.account.playerId);
    assert.ok(Array.isArray(await sender.barrier()));
    await eventually(() => server.stats().online === 1, 'outbound-limit recipient cleanup');
  }
});

test('deeply nested but small JSON is rejected while subsequent valid requests survive', async t => {
  const { url } = await startServer(t);
  const sender = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(sender);
  await enterRoom(peer, room);
  let nested = null;
  for (let i = 0; i < 64; i++) nested = { child: nested };
  await expectError(sender, 'sendToRoom', nested, 'invalid_message');
  await sender.barrier();
  await noRelay(peer, 'messageFromPlayer');
  sender.send('sendToRoom', { valid: true });
  assert.deepEqual((await peer.wait('messageFromPlayer')).data.msg, { valid: true });
});

test('50ms delayed structural frames preserve leave then enter and global request order', async t => {
  const { url } = await startServer(t, { sendDelayMs: 50 });
  const mover = await connect(t, url);
  const oldPeer = await connect(t, url);
  const newPeer = await connect(t, url);
  const first = await createRoom(oldPeer);
  const second = await createRoom(newPeer);
  await enterRoom(mover, first);
  await oldPeer.wait('playerEnter');
  mover.send('leaveRoom');
  mover.send('enterRoom', { roomId: second.roomId });
  mover.send('getPlayers', [mover.account.playerId]);
  assert.equal((await mover.wait('onRoomEnter')).data.roomId, second.roomId);
  assert.equal((await oldPeer.wait('playerLeft')).data, mover.account.playerId);
  assert.equal((await newPeer.wait('playerEnter')).data.playerId, mover.account.playerId);
  const dto = (await mover.wait('onGetPlayers')).data[0];
  assert.ok(Number.isFinite(dto.roomEntryTimestamp));
  const snapshots = await rooms(mover);
  assert.deepEqual(snapshots.find(room => room.roomId === first.roomId).players, [oldPeer.account.playerId]);
  assert.deepEqual(snapshots.find(room => room.roomId === second.roomId).players, [newPeer.account.playerId, mover.account.playerId]);
  mover.assertNo('error');
});

test('delayed room-scoped JSON and binary cannot execute in a different membership', async t => {
  const { url } = await startServer(t, { sendDelayMs: 50 });
  const mover = await connect(t, url);
  const oldPeer = await connect(t, url);
  const newPeer = await connect(t, url);
  const first = await createRoom(oldPeer);
  const second = await createRoom(newPeer);
  await enterRoom(mover, first);
  await oldPeer.wait('playerEnter');
  // Frames arrive on one TCP stream in order. All capture the old membership;
  // structural actions must run, but the following room actions must be fenced.
  mover.send('leaveRoom');
  mover.send('enterRoom', { roomId: second.roomId });
  mover.send('sendToRoom', 'stale-membership');
  mover.send('sendTo', { to: [newPeer.account.playerId], msg: 'stale-membership' });
  mover.ws.send(Buffer.from('stale-membership'));
  mover.send('getPlayers', [mover.account.playerId]);
  await mover.wait('onRoomEnter', data => data.roomId === second.roomId);
  await mover.wait('onGetPlayers');
  for (const peer of [oldPeer, newPeer]) {
    await noRelay(peer, 'messageFromPlayer', data => data.msg === 'stale-membership');
    await noRelay(peer, 'binary');
  }
  mover.send('sendToRoom', 'fresh-membership');
  assert.equal((await newPeer.wait('messageFromPlayer')).data.msg, 'fresh-membership');
  mover.ws.send(Buffer.from('fresh-membership'));
  assert.deepEqual((await newPeer.wait('binary')).data, Buffer.from('fresh-membership'));
});

test('immediate Pong proves queued old-session callbacks before replacement fences them', async t => {
  const delayMs = 200;
  const { url } = await startServer(t, { sendDelayMs: delayMs, heartbeatIntervalMs: 20 });
  const old = await connect(t, url, { name: 'Original session name' });
  const peer = await connect(t, url);
  const room = await createRoom(old);
  await enterRoom(peer, room);
  await old.wait('playerEnter');
  const timestamp = (await old.wait('Ping')).data;
  const queuedAt = Date.now();
  old.send('changeName', 'Stale session name');
  old.send('sendToRoom', 'stale-session');
  old.ws.send(Buffer.from('stale-session'));
  old.send('getPlayers', [peer.account.playerId]);
  old.send('Pong', timestamp);
  // RoomRTT is emitted by maintenance, not delayed dispatch. Seeing the Pong's
  // RTT proves earlier frames were received and queued before replacing the socket.
  await peer.wait('RoomRTT', data => Number.isFinite(data[old.account.playerId]));
  const replacement = await connect(t, url, old.account);
  await replacement.wait('onRoomEnter');
  assert.ok(Date.now() - queuedAt < delayMs, 'Replacement must precede queued callback deadline');
  await waitClosed(old);
  const currentPlayers = await replacement.barrier();
  assert.deepEqual(new Set(currentPlayers.map(dto => dto.playerId)), new Set([old.account.playerId, peer.account.playerId]));
  replacement.assertNo('onGetPlayers');
  const dto = await player(peer, old.account.playerId);
  assert.equal(dto.name, 'Original session name');
  peer.assertNo('nameChanged', data => data.name === 'Stale session name');
  peer.assertNo('messageFromPlayer', data => data.msg === 'stale-session');
  peer.assertNo('binary');
  replacement.send('sendToRoom', 'fresh-session');
  assert.equal((await peer.wait('messageFromPlayer')).data.msg, 'fresh-session');
});
