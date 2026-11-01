'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { connect, createRoom, enterRoom, eventually } = require('./helpers.cjs');
const NodeServer = require('../dist/Server').Server;
const RustServer = require('./rust-server.cjs').Server;
async function launch(t, Backend, dir = '') {
  const s = new Backend({ host: '127.0.0.1', port: 0, sessionDirectory: dir, maxMessagesPerSecond: 10000, maintenanceIntervalMs: 10 });
  t.after(() => s.stop()); await s.start();
  return { server: s, url: `ws://127.0.0.1:${s.address().port}/` };
}
async function reply(c, method, data) {
  const requestId = data.requestId ?? randomUUID();
  c.send(method, { ...data, requestId }); return (await c.wait('sessionReply', d => d.requestId === requestId)).data;
}
async function save(c, bytes, revision, generation) {
  const requestId = randomUUID();
  assert.equal((await reply(c, 'beginSession', { requestId, revision, generation, size: bytes.length })).offset, 0);
  for (let offset = 0; offset < bytes.length; offset += 32000) {
    const payload = bytes.subarray(offset, offset + 32000), b = Buffer.alloc(21 + payload.length);
    b[0] = 2; Buffer.from(requestId.replaceAll('-', ''), 'hex').copy(b, 1); b.writeUInt32BE(offset, 17); payload.copy(b, 21);
    c.ws.send(b); assert.equal((await c.wait('sessionReply')).data.offset, offset + payload.length);
  }
  assert.equal((await reply(c, 'commitSession', { requestId, scheduled: null, immediate: null })).revision, revision + 1);
}
async function load(c) {
  const info = await reply(c, 'getSession', {}), chunks = [];
  for (let offset = 0; offset < info.size;) {
    c.send('getSessionChunk', { requestId: randomUUID(), revision: info.revision, offset });
    const b = (await c.wait('binary')).data; assert.equal(b[0], 3); assert.equal(b.readUInt32BE(17), offset);
    chunks.push(b.subarray(21)); offset += b.length - 21;
  }
  return { ...info, bytes: Buffer.concat(chunks) };
}
test('Node → Rust → Node preserves credentials, roster, opaque state and revision', { skip: process.env.RELAY_BACKEND !== 'rust' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cross-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let instance = await launch(t, NodeServer, dir);
  let owner = await connect(t, instance.url); const credentials = owner.account;
  const room = await createRoom(owner, { binaryRelay: true, password: 'room-secret' });
  owner.send('startGame', { fixedRoster: true, hostMigration: true, persistent: true, bootstrap: ['unchanged', 7] }); await owner.wait('gameStarted');
  let expected = randomBytes(190000); await save(owner, expected, 0, 0); owner.send('leaveRoom');
  await eventually(() => instance.server.stats().rooms === 0); await instance.server.stop();
  for (const [i, Backend] of [RustServer, NodeServer].entries()) {
    instance = await launch(t, Backend, dir); owner = await connect(t, instance.url, credentials);
    owner.send('getSavedRooms', { ids: [room.roomId] }); assert.ok((await owner.wait('savedRoom')).data.room);
    const entered = await enterRoom(owner, room); const restored = await load(owner);
    assert.deepEqual(restored.bytes, expected); assert.equal(restored.revision, i + 1);
    assert.deepEqual(restored.startData.bootstrap, ['unchanged', 7]);
    expected = randomBytes(110000 + i); await save(owner, expected, i + 1, entered.hostGeneration);
    await instance.server.stop();
  }
});
test('Rust accepts numeric JSON forms emitted by non-JavaScript clients', { skip: process.env.RELAY_BACKEND !== 'rust' }, async t => {
  const { url } = await launch(t, RustServer); const c = await connect(t, url);
  c.ws.send('{"method":"createRoom","data":{"name":"C# numeric forms","maxPlayers":4.0}}');
  assert.equal((await c.wait('onRoomEnter')).data.maxPlayers, 4);
});
test('VampireTowers and ForTheWTF legacy F7/F8 tunnel frames remain byte-for-byte opaque', { skip: process.env.RELAY_BACKEND !== 'rust' }, async t => {
  const { url } = await launch(t, RustServer); const host = await connect(t, url), guest = await connect(t, url);
  const room = await createRoom(host); await enterRoom(guest, room);
  host.send('startGame', { fixedRoster: true }); await guest.wait('gameStarted');
  function guidBytes(id) { const b = Buffer.from(id.replaceAll('-', ''), 'hex'); b.subarray(0, 4).reverse(); b.subarray(4, 6).reverse(); b.subarray(6, 8).reverse(); return b; }
  const payload = randomBytes(1500), sender = guidBytes(host.account.playerId), target = guidBytes(guest.account.playerId);
  const length = Buffer.alloc(2); length.writeUInt16LE(payload.length);
  for (const frame of [Buffer.concat([Buffer.from([0xf7]), sender, target, payload]), Buffer.concat([Buffer.from([0xf8]), sender, target, length, payload, target, length, payload])]) {
    host.ws.send(frame); assert.deepEqual((await guest.wait('binary')).data, frame);
  }
});
