'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMessage } = require('../dist/MessageHandler.js');
const { startServer, connect, createRoom, enterRoom, expectError } = require('./helpers.cjs');

test('room settings validate bounds and require at least one setting', () => {
  for (const data of [{}, null, { maxPlayers: 0 }, { maxPlayers: 17 }, { maxPlayers: 2.5 },
    { maxPlayers: '4' }, { password: 123 }, { password: 'x'.repeat(129) },
    { name: '' }, { name: '   ' }, { name: null }, { name: 123 }, { name: 'x'.repeat(65) }]) {
    assert.equal(validateMessage({ method: 'updateRoom', data }, 16, 100), false);
  }
  for (const data of [{ maxPlayers: 2 }, { password: null }, { password: '' }, { password: 'secret' },
    { name: 'Renamed room' }, { name: 'x'.repeat(64) }]) {
    assert.equal(validateMessage({ method: 'updateRoom', data }, 16, 100), true);
  }
});

test('owner updates the existing room, all views agree and new entry uses the updated settings', async t => {
  const { server, url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const lobby = await connect(t, url);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  owner.send('updateRoom', { maxPlayers: 2, password: 'room-secret' });
  const updated = (await owner.wait('roomUpdated')).data;
  assert.equal(updated.roomId, room.roomId);
  assert.equal(updated.maxPlayers, 2);
  assert.equal(updated.hasPassword, true);
  assert.deepEqual(updated.players, [owner.account.playerId, peer.account.playerId]);
  assert.equal(Object.hasOwn(updated, 'password'), false);
  assert.deepEqual((await peer.wait('roomUpdated')).data, updated);
  assert.deepEqual((await lobby.wait('roomUpdated')).data, updated);
  await expectError(lobby, 'enterRoom', { roomId: room.roomId }, 'wrong_password');
  await expectError(lobby, 'enterRoom', { roomId: room.roomId, password: 'room-secret' }, 'full_room');
  owner.send('updateRoom', { maxPlayers: 3 });
  assert.equal((await owner.wait('roomUpdated')).data.hasPassword, true);
  await enterRoom(lobby, room, 'room-secret');
  assert.equal(server.stats().rooms, 1);
  owner.send('sendToRoom', 'still-here');
  assert.equal((await peer.wait('messageFromPlayer')).data.msg, 'still-here');
});

test('settings reject non-owners, occupied-slot reductions and changes after start atomically', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  await expectError(owner, 'updateRoom', { maxPlayers: 2 }, 'no_room');
  const room = await createRoom(owner, { password: 'original' });
  await enterRoom(peer, room, 'original');
  await expectError(peer, 'updateRoom', { maxPlayers: 2 }, 'not_room_owner');
  await expectError(owner, 'updateRoom', { maxPlayers: 1, password: null }, 'room_too_small');
  owner.send('getRooms');
  const unchanged = (await owner.wait('onGetRooms')).data[0];
  assert.equal(unchanged.maxPlayers, 4);
  assert.equal(unchanged.hasPassword, true);
  owner.send('startGame', {});
  await owner.wait('gameStarted');
  await expectError(owner, 'updateRoom', { password: null }, 'already_started');
});

test('password can be replaced or removed without exposing it and ownership transfer permits editing', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const newcomer = await connect(t, url);
  const room = await createRoom(owner, { password: 'old-secret' });
  await enterRoom(peer, room, 'old-secret');
  owner.send('updateRoom', { password: 'new-secret' });
  await owner.wait('roomUpdated');
  await peer.wait('roomUpdated');
  await expectError(newcomer, 'enterRoom', { roomId: room.roomId, password: 'old-secret' }, 'wrong_password');
  owner.send('leaveRoom');
  await peer.wait('newRoomOwner');
  peer.send('updateRoom', { password: null });
  const updated = (await peer.wait('roomUpdated', data => !data.hasPassword)).data;
  assert.equal(updated.ownerId, peer.account.playerId);
  assert.equal(updated.roomId, room.roomId);
  await enterRoom(newcomer, room);
  peer.send('updateRoom', { password: '' });
  assert.equal((await peer.wait('roomUpdated')).data.hasPassword, false);
});

test('capacity growth still reserves enough room DTO space and failed growth changes nothing', async t => {
  const { url } = await startServer(t, { maxRoomPlayers: 100, maxPayloadBytes: 1024 });
  const owner = await connect(t, url);
  await createRoom(owner, { maxPlayers: 2 });
  await expectError(owner, 'updateRoom', { name: 'Renamed', maxPlayers: 100, password: 'secret' }, 'payload_too_large');
  owner.send('getRooms');
  const room = (await owner.wait('onGetRooms')).data[0];
  assert.equal(room.maxPlayers, 2);
  assert.equal(room.hasPassword, false);
  assert.equal(room.name, 'Test room');
});

test('room rename reaches members and lobby without changing membership or other settings', async t => {
  const { url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const lobby = await connect(t, url);
  const room = await createRoom(owner, { password: 'keep-secret', maxPlayers: 3 });
  await enterRoom(peer, room, 'keep-secret');
  await expectError(peer, 'updateRoom', { name: 'Guest rename' }, 'not_room_owner');
  owner.send('updateRoom', { name: 'New room name' });
  const updated = (await owner.wait('roomUpdated')).data;
  assert.deepEqual(updated, { ...room, name: 'New room name', players: [owner.account.playerId, peer.account.playerId] });
  assert.deepEqual((await peer.wait('roomUpdated')).data, updated);
  assert.deepEqual((await lobby.wait('roomUpdated')).data, updated);
  lobby.send('getRooms');
  assert.deepEqual((await lobby.wait('onGetRooms')).data, [updated]);
  await expectError(lobby, 'enterRoom', { roomId: room.roomId }, 'wrong_password');
  await enterRoom(lobby, room, 'keep-secret');
  owner.send('startGame', {});
  await owner.wait('gameStarted');
  await expectError(owner, 'updateRoom', { name: 'Started rename' }, 'already_started');
});

test('a longer room name cannot exceed reserved DTO capacity or partially change settings', async t => {
  const { url } = await startServer(t, { maxPayloadBytes: 1024 });
  const owner = await connect(t, url);
  const room = await createRoom(owner, { name: 'A', maxPlayers: 2 });
  const reserved = { ...room, rtt: Number.MAX_SAFE_INTEGER, players: [owner.account.playerId, owner.account.playerId], metaData: '' };
  const overhead = Buffer.byteLength(JSON.stringify({ method: 'onGetRooms', data: [reserved], nextCursor: room.roomId }));
  owner.send('setRoomMeta', 'x'.repeat(1024 - overhead));
  await owner.wait('onSetRoomMeta');
  await expectError(owner, 'updateRoom', { name: 'x'.repeat(64), password: 'new-secret' }, 'payload_too_large');
  owner.send('getRooms');
  const unchanged = (await owner.wait('onGetRooms')).data[0];
  assert.equal(unchanged.name, 'A');
  assert.equal(unchanged.hasPassword, false);
});
