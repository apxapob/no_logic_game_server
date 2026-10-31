'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync, rmdirSync, existsSync, mkdirSync, writeFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { startServer, connect, createRoom, enterRoom, eventually } = require('./helpers.cjs');
const directories = [];
test.after(() => {
  for (const path of directories) {
    assert.ok(path.startsWith(join(tmpdir(), 'relay-sessions-')));
    rmSync(path, { recursive: true, force: true });
  }
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'relay-sessions-'));
  directories.push(path);
  return path;
}
async function reply(c, method, data = {}) {
  const requestId = data.requestId ?? randomUUID();
  c.send(method, { ...data, requestId });
  return (await c.wait('sessionReply', d => d.requestId === requestId)).data;
}
async function save(c, bytes, revision = 0, generation = 0, notices = {}) {
  const requestId = randomUUID();
  assert.equal((await reply(c, 'beginSession', { requestId, size: bytes.length, revision, generation })).offset, 0);
  for (let offset = 0; offset < bytes.length; offset += 32000) {
    const chunk = bytes.subarray(offset, offset + 32000);
    const frame = Buffer.alloc(21 + chunk.length); frame[0] = 2;
    Buffer.from(requestId.replaceAll('-', ''), 'hex').copy(frame, 1); frame.writeUInt32BE(offset, 17); chunk.copy(frame, 21);
    c.ws.send(frame);
    assert.equal((await c.wait('sessionReply', d => d.requestId === requestId)).data.offset, offset + chunk.length);
  }
  const result = await reply(c, 'commitSession', { requestId, scheduled: null, immediate: null, ...notices });
  assert.equal(result.revision, revision + 1);
  return result.revision;
}
async function load(c) {
  const info = await reply(c, 'getSession');
  const parts = [];
  for (let offset = 0; offset < info.size;) {
    c.send('getSessionChunk', { requestId: randomUUID(), revision: info.revision, offset });
    const frame = (await c.wait('binary')).data;
    assert.equal(frame[0], 3); assert.equal(frame.readUInt32BE(17), offset);
    parts.push(frame.subarray(21)); offset += frame.length - 21;
  }
  return { ...info, bytes: Buffer.concat(parts) };
}
async function match(t, options = {}) {
  const instance = await startServer(t, options);
  const host = await connect(t, instance.url), guest = await connect(t, instance.url);
  const room = await createRoom(host, { binaryRelay: true });
  await enterRoom(guest, room);
  host.send('startGame', { fixedRoster: true, hostMigration: true, persistent: true, example: 'opaque bootstrap' });
  await host.wait('gameStarted'); await guest.wait('gameStarted');
  return { ...instance, host, guest, room };
}
test('opaque binary session is saved only on last departure; credentials and roster survive restart', async t => {
  const dir = directory(t);
  const { server, host, guest, room } = await match(t, { sessionDirectory: dir });
  const bytes = randomBytes(100000);
  await save(host, bytes);
  assert.equal(existsSync(join(dir, 'rooms', `${room.roomId}.bin`)), false);
  host.send('leaveRoom'); await guest.wait('newRoomOwner');
  assert.equal(existsSync(join(dir, 'rooms', `${room.roomId}.bin`)), false);
  guest.send('leaveRoom'); await eventually(() => server.stats().rooms === 0);
  assert.ok(existsSync(join(dir, 'rooms', `${room.roomId}.bin`)));
  await server.stop();
  const next = await startServer(t, { sessionDirectory: dir });
  assert.equal(next.server.stats().rooms, 0);
  const returning = await connect(t, next.url, guest.account);
  returning.send('getSavedRooms', { ids: [room.roomId] });
  const lookup = (await returning.wait('savedRoom')).data;
  assert.deepEqual(lookup.room.players, []);
  assert.equal(next.server.stats().rooms, 0, 'lookup reads only header and does not retain world');
  const entered = await enterRoom(returning, room);
  assert.equal(entered.ownerId, guest.account.playerId);
  assert.equal(entered.participants.length, 2);
  const restored = await load(returning);
  assert.deepEqual(restored.bytes, bytes); assert.equal(restored.revision, 1);
  assert.equal(restored.startData.example, 'opaque bootstrap');
  const outsider = await connect(t, next.url);
  outsider.send('getSavedRooms', { ids: [room.roomId] });
  assert.equal((await outsider.wait('savedRoom')).data.room, null);
});
test('partial uploads never replace committed state; stale generation and revision cannot overwrite it', async t => {
  const { host, guest, room } = await match(t, { sessionDirectory: directory(t) });
  await save(host, Buffer.from('confirmed'));
  await reply(host, 'beginSession', { size: 100, revision: 1, generation: 0 });
  host.send('leaveRoom');
  const generation = (await guest.wait('newRoomOwner')).data.generation;
  assert.deepEqual((await load(guest)).bytes, Buffer.from('confirmed'));
  assert.equal((await reply(guest, 'beginSession', { size: 10, revision: 1, generation: 0 })).error, 'stale_session');
  await save(guest, Buffer.from('new confirmed'), 1, generation);
  assert.equal((await reply(guest, 'beginSession', { size: 10, revision: 1, generation })).error, 'stale_session');
  await enterRoom(host, room);
  assert.equal((await reply(host, 'beginSession', { size: 10, revision: 2, generation })).error, 'not_room_owner');
});
test('graceful shutdown flushes active rooms and expired accounts can authenticate from disk', async t => {
  const dir = directory(t);
  const { server, host, guest, room } = await match(t, { sessionDirectory: dir, accountTtlMs: 1 });
  await save(host, Buffer.from('shutdown'));
  await server.stop();
  const next = await startServer(t, { sessionDirectory: dir, accountTtlMs: 1 });
  const returning = await connect(t, next.url, host.account);
  await enterRoom(returning, room);
  assert.equal((await load(returning)).bytes.toString(), 'shutdown');
  const other = await connect(t, next.url, guest.account);
  await enterRoom(other, room);
});
test('disk eviction uses last state update, protects active rooms, and removes notification jobs', async t => {
  const { SessionStore } = require('../dist/SessionStore');
  const { Room } = require('../dist/Room');
  const store = new SessionStore(directory(t), 1);
  const older = new Room('older', randomUUID(), 2, null, null);
  const newer = new Room('newer', randomUUID(), 2, null, null);
  older.updatedAt = 200; newer.updatedAt = 100;
  store.save(older); store.save(newer);
  store.setJobs(newer.roomId, [{ eventId: 'x', at: 1, to: [], title: 'x', body: 'x', done: [], retryAt: 0, scheduled: true }]);
  assert.deepEqual(store.prune(new Set([older.roomId])), [newer.roomId]);
  assert.ok(store.load(older.roomId)); assert.equal(store.load(newer.roomId), undefined);
  assert.equal(store.jobs.has(newer.roomId), false);
});
test('offline deadline notification survives restart, is cancelled/replaced, and is sent once', async t => {
  const dir = directory(t), sent = [];
  const pushSender = async (token, notification) => { sent.push({ token, ...notification }); return 'sent'; };
  const { server, host, guest } = await match(t, { sessionDirectory: dir, pushSender });
  guest.send('setPushDevice', { deviceId: randomUUID(), token: 'test-token-12345678901234567890', foreground: false, language: 'ru' });
  await guest.wait('pushDeviceUpdated');
  const notice = { eventId: 'new', at: Date.now() + 10000, to: [guest.account.playerId], title: 'General', body: 'expired', translations: { ru: { title: 'General', body: 'localized' } } };
  await save(host, Buffer.from('first'), 0, 0, { scheduled: notice });
  await save(host, Buffer.from('second'), 1, 0, { scheduled: { ...notice, eventId: 'new', at: Date.now() + 150 } });
  await server.stop();
  const next = await startServer(t, { sessionDirectory: dir, pushSender });
  await eventually(() => sent.length === 1);
  assert.equal(next.server.stats().rooms, 0);
  assert.equal(sent[0].eventId, 'new'); assert.equal(sent[0].body, 'localized');
  await next.server.stop();
  await startServer(t, { sessionDirectory: dir, pushSender });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(sent.length, 1);
});

test('queued push retries after restart and a foreground player in another room still receives it', async t => {
  const dir = directory();
  let attempts = 0;
  const sent = [];
  const pushSender = async (_token, notice) => {
    if (++attempts === 1) throw new Error('temporary provider outage');
    sent.push(notice); return 'sent';
  };
  const { server, host, guest, room } = await match(t, { sessionDirectory: dir, pushSender });
  guest.send('setPushDevice', { deviceId: randomUUID(), token: 'test-token-12345678901234567890', foreground: true });
  await guest.wait('pushDeviceUpdated');
  guest.send('leaveRoom'); await host.wait('playerLeft');
  await createRoom(guest);
  await save(host, Buffer.from('result'), 0, 0, { immediate: {
    eventId: 'turn.2', at: 0, to: [guest.account.playerId], title: 'General', body: 'Next turn',
  } });
  await eventually(() => attempts === 1);
  await server.stop();
  const { SessionStore } = require('../dist/SessionStore');
  const store = new SessionStore(dir, 1024 ** 3);
  const jobs = store.jobs.get(room.roomId);
  assert.equal(jobs.length, 1);
  jobs[0].retryAt = 0;
  store.setJobs(room.roomId, jobs);
  const next = await startServer(t, { sessionDirectory: dir, pushSender });
  await eventually(() => sent.length === 1);
  assert.equal(sent[0].eventId, 'turn.2');
  assert.equal(next.server.stats().rooms, 0);
});

test('clearing a scheduled notification prevents delivery while all players are away', async t => {
  let sends = 0;
  const { server, host, guest } = await match(t, { sessionDirectory: directory(), pushSender: async () => { sends++; return 'sent'; } });
  guest.send('setPushDevice', { deviceId: randomUUID(), token: 'test-token-12345678901234567890', foreground: false });
  await guest.wait('pushDeviceUpdated');
  await save(host, Buffer.from('running'), 0, 0, { scheduled: { eventId: 'deadline.1', at: Date.now() + 100,
    to: [guest.account.playerId], title: 'General', body: 'Time' } });
  await save(host, Buffer.from('paused'), 1, 0);
  host.send('leaveRoom'); guest.send('leaveRoom');
  await eventually(() => server.stats().rooms === 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(sends, 0);
});

test('failed final disk write retains the authoritative room and retries after storage recovers', async t => {
  const dir = directory();
  const { server, host, guest, room } = await match(t, { sessionDirectory: dir });
  const bytes = randomBytes(90000);
  await save(host, bytes);
  // A directory at the temporary-file path reliably produces a write error on Windows and Linux.
  const blocker = join(dir, 'rooms', `${room.roomId}.bin.tmp`);
  mkdirSync(blocker);
  host.send('leaveRoom'); guest.send('leaveRoom');
  await eventually(() => server.rooms.get(room.roomId)?.active.size === 0);
  assert.equal(server.stats().rooms, 1);
  assert.deepEqual(server.rooms.get(room.roomId).sessionState, bytes);
  assert.equal(existsSync(join(dir, 'rooms', `${room.roomId}.bin`)), false);
  rmdirSync(blocker);
  await eventually(() => server.stats().rooms === 0);
  await enterRoom(guest, room);
  assert.deepEqual((await load(guest)).bytes, bytes);
});

test('notification write failure rejects a commit without changing revision or confirmed bytes', async t => {
  const dir = directory();
  const { host, room } = await match(t, { sessionDirectory: dir });
  await save(host, Buffer.from('confirmed'));
  const blocker = join(dir, 'notifications', `${room.roomId}.json.tmp`);
  mkdirSync(blocker);
  const requestId = randomUUID();
  await reply(host, 'beginSession', { requestId, size: 1, revision: 1, generation: 0 });
  const frame = Buffer.alloc(22); frame[0] = 2;
  Buffer.from(requestId.replaceAll('-', ''), 'hex').copy(frame, 1);
  host.ws.send(frame); await host.wait('sessionReply', d => d.requestId === requestId);
  const result = await reply(host, 'commitSession', { requestId, immediate: null,
    scheduled: { eventId: 'deadline', at: Date.now() + 10000, to: [], title: 'G', body: 'Time' } });
  assert.equal(result.error, 'storage_error');
  const confirmed = await load(host);
  assert.equal(confirmed.revision, 1); assert.equal(confirmed.bytes.toString(), 'confirmed');
  rmdirSync(blocker);
  await save(host, Buffer.from('recovered'), 1);
});

test('interrupted, repeated, and expired chunk uploads leave the previous state intact', async t => {
  const { server, host, room } = await match(t, { sessionDirectory: directory() });
  await save(host, Buffer.from('confirmed'));
  const requestId = randomUUID();
  await reply(host, 'beginSession', { requestId, size: 10, revision: 1, generation: 0 });
  const frame = Buffer.alloc(26); frame[0] = 2;
  Buffer.from(requestId.replaceAll('-', ''), 'hex').copy(frame, 1);
  host.ws.send(frame); await host.wait('sessionReply', d => d.requestId === requestId);
  host.ws.send(frame);
  assert.equal((await host.wait('sessionReply', d => d.requestId === requestId)).data.error, 'stale_session');
  assert.equal((await load(host)).bytes.toString(), 'confirmed');
  await reply(host, 'beginSession', { size: 10, revision: 1, generation: 0 });
  server.rooms.get(room.roomId).upload.at = Date.now() - 31000;
  await eventually(() => server.rooms.get(room.roomId).upload === null);
  assert.equal((await load(host)).bytes.toString(), 'confirmed');
  await save(host, randomBytes(125000), 1);
});

test('200 sleeping sessions remain off the live-room map; batch lookups and every payload survive restart', async t => {
  const dir = directory();
  const { SessionStore } = require('../dist/SessionStore');
  const { Room } = require('../dist/Room');
  const { Player } = require('../dist/Player');
  const store = new SessionStore(dir, 1024 ** 3);
  const owner = new Player('Capacity'); store.saveAccount(owner);
  const bytes = randomBytes(100000), ids = [];
  for (let i = 0; i < 200; i++) {
    const room = new Room(`room-${i}`, owner.playerId, 3, null, null);
    room.gamePlayers.add(owner.playerId); room.sessionState = bytes;
    room.revision = i + 1; room.updatedAt = 1000 + i;
    store.save(room); ids.push(room.roomId);
  }
  assert.equal(readdirSync(join(dir, 'rooms')).length, 200);
  const { server, url } = await startServer(t, { sessionDirectory: dir, maxConnectionsPerMinute: 1000 });
  const c = await connect(t, url, { playerId: owner.playerId, password: owner.password });
  for (let i = 0; i < ids.length; i += 20) {
    c.send('getSavedRooms', { ids: ids.slice(i, i + 20) });
    for (const id of ids.slice(i, i + 20)) assert.ok((await c.wait('savedRoom', d => d.roomId === id)).data.room);
    assert.equal(server.stats().rooms, 0);
  }
  for (const [i, id] of ids.entries()) {
    const restored = server.store.load(id);
    assert.equal(restored.revision, i + 1); assert.deepEqual(restored.sessionState, bytes);
  }
  await enterRoom(c, { roomId: ids[37] });
  assert.equal(server.stats().rooms, 1);
  assert.deepEqual((await load(c)).bytes, bytes);
  c.send('leaveRoom'); await eventually(() => server.stats().rooms === 0);
});

test('a corrupt room does not prevent reading another room or checking an absent room', async t => {
  const dir = directory();
  const { server, host, guest, room } = await match(t, { sessionDirectory: dir });
  await save(host, Buffer.from('healthy'));
  host.send('leaveRoom'); guest.send('leaveRoom');
  await eventually(() => server.stats().rooms === 0);
  const corruptId = randomUUID();
  writeFileSync(join(dir, 'rooms', `${corruptId}.bin`), Buffer.from([0, 0]));
  // Separate requests ensure a malformed file cannot take down the connection/process.
  host.send('getSavedRooms', { ids: [corruptId] });
  await host.wait('error');
  const missing = randomUUID();
  host.send('getSavedRooms', { ids: [missing, room.roomId] });
  assert.equal((await host.wait('savedRoom', d => d.roomId === missing)).data.room, null);
  assert.ok((await host.wait('savedRoom', d => d.roomId === room.roomId)).data.room);
  await enterRoom(host, room); assert.equal((await load(host)).bytes.toString(), 'healthy');
});

test('hard process kill preserves sleeping state and active changes roll back to the last disk save', async t => {
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const dir = directory();
  async function child() {
    const process = fork(join(__dirname, 'fixtures/session-child.cjs'), [dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(process, 'exit');
    t.after(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exited; });
    const [{ url }] = await once(process, 'message');
    return { url, kill: async () => { process.kill('SIGKILL'); await exited; } };
  }
  let relay = await child();
  let host = await connect(t, relay.url);
  const credentials = host.account;
  const room = await createRoom(host, { binaryRelay: true });
  host.send('startGame', { fixedRoster: true, hostMigration: true, persistent: true });
  await host.wait('gameStarted');
  const sleeping = randomBytes(135000);
  await save(host, sleeping);
  host.send('leaveRoom');
  await eventually(() => existsSync(join(dir, 'rooms', `${room.roomId}.bin`)));
  await relay.kill();
  relay = await child();
  host = await connect(t, relay.url, credentials);
  const entered = await enterRoom(host, room);
  assert.deepEqual((await load(host)).bytes, sleeping);
  await save(host, Buffer.from('active changes deliberately not yet flushed'), 1, entered.hostGeneration);
  await relay.kill();
  relay = await child();
  host = await connect(t, relay.url, credentials);
  const restored = await enterRoom(host, room);
  const state = await load(host);
  assert.equal(state.revision, 1); assert.deepEqual(state.bytes, sleeping);
  await save(host, Buffer.from('continued after crash'), 1, restored.hostGeneration);
  host.send('leaveRoom'); await host.barrier();
});

test('a corrupt notification file does not prevent startup or delivery for healthy rooms', async t => {
  const dir = directory();
  const { SessionStore } = require('../dist/SessionStore');
  const store = new SessionStore(dir, 1024 ** 3);
  const healthy = randomUUID(), corrupt = randomUUID(), malformed = randomUUID();
  store.setJobs(healthy, [{ eventId: 'valid', at: 0, to: [], title: 'G', body: 'T', done: [], retryAt: 0, scheduled: true }]);
  writeFileSync(join(dir, 'notifications', `${corrupt}.json`), '{');
  writeFileSync(join(dir, 'notifications', `${malformed}.json`), '{}');
  const logs = [];
  const { server } = await startServer(t, { sessionDirectory: dir, logger: text => logs.push(text), pushSender: async () => 'sent' });
  await eventually(() => server.store.jobs.get(healthy)?.[0].retryAt === Number.MAX_SAFE_INTEGER);
  assert.equal(server.store.jobs.has(corrupt), false);
  assert.equal(server.store.jobs.has(malformed), false);
  assert.equal(logs.filter(text => text.includes('notification file')).length, 2);
});

test('quota cleanup can evict a corrupt room without blocking startup or deleting a healthy room', () => {
  const dir = directory();
  const { SessionStore } = require('../dist/SessionStore');
  const { Room } = require('../dist/Room');
  const store = new SessionStore(dir, 1024 ** 3);
  const room = new Room('healthy', randomUUID(), 2, null, null);
  room.sessionState = Buffer.from('healthy'); store.save(room);
  const corruptId = randomUUID();
  writeFileSync(join(dir, 'rooms', `${corruptId}.bin`), Buffer.alloc(10000, 255));
  const restored = new SessionStore(dir, 1000);
  assert.equal(restored.load(corruptId), undefined);
  assert.equal(restored.load(room.roomId).sessionState.toString(), 'healthy');
});

test('one account can switch between saved rooms without mixing state, roster, or revision', async t => {
  const dir = directory();
  const { server, host, guest, room: first } = await match(t, { sessionDirectory: dir });
  await save(host, Buffer.from('first world'));
  host.send('leaveRoom'); guest.send('leaveRoom');
  await eventually(() => server.stats().rooms === 0);
  const second = await createRoom(host, { binaryRelay: true });
  host.send('startGame', { fixedRoster: true, hostMigration: true, persistent: true });
  await host.wait('gameStarted'); await save(host, Buffer.from('second world'));
  host.send('leaveRoom'); await eventually(() => server.stats().rooms === 0);
  host.send('getSavedRooms', { ids: [first.roomId, second.roomId] });
  for (const id of [first.roomId, second.roomId]) assert.ok((await host.wait('savedRoom', d => d.roomId === id)).data.room);
  guest.send('getSavedRooms', { ids: [first.roomId, second.roomId] });
  assert.ok((await guest.wait('savedRoom', d => d.roomId === first.roomId)).data.room);
  assert.equal((await guest.wait('savedRoom', d => d.roomId === second.roomId)).data.room, null);
  for (const [room, content] of [[first, 'first world'], [second, 'second world'], [first, 'first world']]) {
    await enterRoom(host, room);
    const state = await load(host);
    assert.equal(state.revision, 1); assert.equal(state.bytes.toString(), content);
    host.send('leaveRoom'); await eventually(() => server.stats().rooms === 0);
  }
});

test('offline notification reaches each device once, drops invalid tokens, and isolates provider failure', async t => {
  const dir = directory(), sends = [];
  let failed = false;
  const pushSender = async token => {
    sends.push(token);
    if (token.startsWith('invalid')) return 'invalid';
    if (token.startsWith('retry') && !failed) { failed = true; throw new Error('provider unavailable'); }
    return 'sent';
  };
  const { server, host, guest, room } = await match(t, { sessionDirectory: dir, pushSender });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const tokens = ['healthy', 'invalid', 'retry'].map(prefix => `${prefix}-token-12345678901234567890`);
  for (let i = 0; i < ids.length; i++) {
    guest.send('setPushDevice', { deviceId: ids[i], token: tokens[i], foreground: false });
    await guest.wait('pushDeviceUpdated');
  }
  const notice = { eventId: 'multi-device', at: 0, to: [guest.account.playerId], title: 'G', body: 'T' };
  await save(host, Buffer.from('new year'), 0, 0, { immediate: notice });
  await eventually(() => sends.length === 3 && server.store.jobs.get(room.roomId)?.[0].retryAt > Date.now());
  server.store.jobs.get(room.roomId)[0].retryAt = 0;
  await eventually(() => sends.length === 4 && !server.store.jobs.has(room.roomId));
  assert.deepEqual(sends, [...tokens, tokens[2]]);
  assert.equal(server.store.account(guest.account.playerId).pushDevices.has(ids[1]), false);
  await save(host, Buffer.from('same event, newer revision'), 1, 0, { immediate: notice });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sends.length, 4);
});
