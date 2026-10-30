'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer, connect, createRoom, enterRoom, expectError } = require('./helpers.cjs');
const { binaryTarget, binaryFrom } = require('../dist/BinaryRelay.js');

function packet(target, payload = Buffer.from([255, 0, 128, 42])) {
  const bytes = Buffer.alloc(17 + payload.length);
  bytes[0] = 1;
  if (target) Buffer.from(target.replaceAll('-', ''), 'hex').copy(bytes, 1);
  payload.copy(bytes, 17);
  return bytes;
}

test('opt-in binary routing authenticates senders, targets peers and keeps opaque bytes intact', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url), a = await connect(t, url), b = await connect(t, url);
  const outsider = await connect(t, url);
  const room = await createRoom(owner, { binaryRelay: true });
  assert.equal(room.binaryRelay, true);
  assert.equal((await enterRoom(a, room)).binaryRelay, true);
  await enterRoom(b, room);
  await createRoom(outsider, { binaryRelay: true });
  const bytes = packet(a.account.playerId);
  owner.ws.send(bytes);
  const delivered = (await a.wait('binary')).data;
  assert.equal(delivered.subarray(1, 17).toString('hex'), owner.account.playerId.replaceAll('-', ''));
  assert.deepEqual(delivered.subarray(17), bytes.subarray(17));
  assert.equal(delivered.length, bytes.length);
  owner.ws.send(packet(outsider.account.playerId));
  owner.ws.send(packet(null));
  for (const peer of [a, b]) {
    const received = (await peer.wait('binary')).data;
    assert.equal(received.subarray(1, 17).toString('hex'), owner.account.playerId.replaceAll('-', ''));
  }
  await delay(40);
  for (const peer of [owner, outsider, a, b]) peer.assertNo('binary');
});

test('binary mode is explicit, rejects malformed routing headers and preserves legacy raw relay', async t => {
  const { url } = await startServer(t);
  const a = await connect(t, url), b = await connect(t, url);
  await expectError(a, 'createRoom', { name: 'room', maxPlayers: 4, binaryRelay: 'yes' }, 'invalid_message');
  let room = await createRoom(a, { binaryRelay: true });
  await enterRoom(b, room);
  for (const bytes of [Buffer.alloc(17), Buffer.alloc(18, 9), packet('00112233-4455-0677-8899-aabbccddeeff'), packet('00112233-4455-4677-ff99-aabbccddeeff')]) {
    a.ws.send(bytes);
    assert.equal((await a.wait('error')).data.code, 'invalid_message');
  }
  b.assertNo('binary');
  a.send('leaveRoom');
  room = await createRoom(a);
  assert.equal(room.binaryRelay, undefined);
  b.send('leaveRoom');
  await enterRoom(b, room);
  const raw = Buffer.from('arbitrary legacy payload');
  a.ws.send(raw);
  assert.deepEqual((await b.wait('binary')).data, raw);
});

test('delayed routed binary cannot escape its original membership', async t => {
  const { url, server } = await startServer(t);
  const a = await connect(t, url), b = await connect(t, url), c = await connect(t, url);
  const room = await createRoom(a, { binaryRelay: true });
  await enterRoom(b, room);
  const next = await createRoom(c, { binaryRelay: true });
  server.options.sendDelayMs = 80;
  a.send('leaveRoom');
  a.send('enterRoom', { roomId: next.roomId });
  a.ws.send(packet(null));
  await a.wait('onRoomEnter');
  await delay(150);
  b.assertNo('binary');
  c.assertNo('binary');
  a.ws.send(packet(c.account.playerId));
  assert.equal((await c.wait('binary')).data.subarray(1, 17).toString('hex'), a.account.playerId.replaceAll('-', ''));
});

test('binary UUID wire order preserves leading zeroes and uses exactly 16 address bytes', () => {
  const id = '00112233-4455-4677-8899-aabbccddeeff';
  const bytes = Buffer.from([1, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x42]);
  assert.equal(binaryTarget(bytes), id);
  assert.deepEqual(binaryFrom(packet(null, Buffer.from([0x42])), id.toUpperCase()), bytes);
  assert.equal(binaryTarget(packet(null)), null);
  assert.equal(binaryTarget(bytes.subarray(0, 17)), undefined);
});
