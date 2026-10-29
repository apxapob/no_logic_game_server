'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, createRoom, enterRoom, expectError } = require('./helpers.cjs');

test('a new account can replace a departed player, but cannot add a seat to a running game', async t => {
  const { url } = await startServer(t);
  const host = await connect(t, url);
  const peer = await connect(t, url);
  const replacement = await connect(t, url);
  const room = await createRoom(host, { maxPlayers: 4 });
  await enterRoom(peer, room);
  host.send('startGame', { allowReplacement: true });
  await peer.wait('gameStarted');
  await expectError(replacement, 'enterRoom', { roomId: room.roomId }, 'game_started_without_you');
  await peer.close();
  await host.wait('playerDisconnected');
  replacement.send('getRooms');
  assert.equal((await replacement.wait('onGetRooms')).data[0].roomId, room.roomId);
  const resumed = await enterRoom(replacement, room);
  assert.equal(resumed.gameStarted, true);
  assert.equal(resumed.ownerId, host.account.playerId);
  assert.equal(resumed.players.length, 2);
  const extra = await connect(t, url);
  await expectError(extra, 'enterRoom', { roomId: room.roomId }, 'game_started_without_you');
  replacement.send('leaveRoom');
  await host.wait('playerLeft');
  await enterRoom(extra, room);
});

test('host loss ends a reconnectable room and releases every surviving player into the lobby', async t => {
  const { server, url } = await startServer(t);
  const host = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(host);
  await enterRoom(peer, room);
  host.send('startGame', { allowReplacement: true });
  await peer.wait('gameStarted');
  await host.close();
  assert.equal((await peer.wait('playerDisconnected')).data, host.account.playerId);
  await peer.barrier();
  peer.assertNo('newRoomOwner');
  assert.equal(server.stats().rooms, 0);
  await createRoom(peer);
});

test('replacement entry respects room passwords', async t => {
  const { url } = await startServer(t);
  const host = await connect(t, url);
  const peer = await connect(t, url);
  const replacement = await connect(t, url);
  const room = await createRoom(host, { password: 'secret' });
  await enterRoom(peer, room, 'secret');
  host.send('startGame', { allowReplacement: true });
  await peer.wait('gameStarted');
  await peer.close();
  await host.wait('playerDisconnected');
  await expectError(replacement, 'enterRoom', { roomId: room.roomId }, 'wrong_password');
  await enterRoom(replacement, room, 'secret');
});
