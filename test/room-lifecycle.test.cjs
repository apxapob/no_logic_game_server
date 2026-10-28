'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eventually, startServer, connect, createRoom, enterRoom, waitClosed,
} = require('./helpers.cjs');

function answerHeartbeats(client) {
  client.ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === 'Ping') client.send('Pong', message.data);
  });
}

for (const started of [false, true]) {
  test(`a stalled close cannot retain the last member of a ${started ? 'started' : 'waiting'} room`, async t => {
    const { server, url } = await startServer(t, { heartbeatIntervalMs: 50, idleTimeoutMs: 300 });
    const owner = await connect(t, url);
    const observer = await connect(t, url);
    answerHeartbeats(observer);
    const room = await createRoom(owner, { maxPlayers: 3 });
    if (started) {
      owner.send('startGame', {});
      await owner.wait('gameStarted');
    }

    // Send Close, but stop reading the server's reply: TCP stays open and ws
    // cannot finish its close handshake until its separate 30-second deadline.
    owner.ws.pause();
    owner.ws.close();

    await eventually(() => server.stats().rooms === 0 && server.stats().online === 1,
      'room cleanup while the close handshake is stalled', 1000);
    assert.equal((await observer.wait('roomDeleted')).data, room.roomId);
    observer.send('getRooms');
    assert.deepEqual((await observer.wait('onGetRooms')).data, []);
    assert.deepEqual((await observer.barrier()).map(player => player.playerId), [observer.account.playerId]);

    owner.ws.resume();
    await waitClosed(owner);
    await observer.barrier();
    observer.assertNo('roomDeleted');
  });
}

test('stalled owner close transfers ownership; its late close cannot remove a reconnected member', async t => {
  const { server, url } = await startServer(t);
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  owner.send('startGame', {});
  await peer.wait('gameStarted');

  owner.ws.pause();
  owner.ws.close();
  assert.equal((await peer.wait('playerDisconnected', () => true, 1000)).data, owner.account.playerId);
  assert.equal((await peer.wait('newRoomOwner')).data, peer.account.playerId);
  const returning = await connect(t, url, owner.account);
  const restored = await enterRoom(returning, room);
  assert.equal(restored.ownerId, peer.account.playerId);
  assert.deepEqual(new Set(restored.players), new Set([owner.account.playerId, peer.account.playerId]));

  owner.ws.resume();
  await waitClosed(owner);
  await returning.barrier();
  await peer.barrier();
  peer.assertNo('playerDisconnected');
  peer.assertNo('newRoomOwner');
  assert.equal(server.stats().online, 2);
  assert.equal(server.stats().rooms, 1);
  returning.send('sendToRoom', 'still connected');
  assert.equal((await peer.wait('messageFromPlayer')).data.msg, 'still connected');
  returning.send('leaveRoom');
  assert.equal((await peer.wait('playerLeft')).data, owner.account.playerId);
  peer.send('leaveRoom');
  await eventually(() => server.stats().rooms === 0, 'final room disposal');
});

test('silent players time out without a close frame; reconnect reservations cannot keep an empty match alive', async t => {
  const { server, url } = await startServer(t, { heartbeatIntervalMs: 50, idleTimeoutMs: 500 });
  const observer = await connect(t, url);
  answerHeartbeats(observer);
  const clients = [];
  for (let i = 0; i < 3; i++) clients.push(await connect(t, url));
  const room = await createRoom(clients[0], { maxPlayers: 3 });
  for (const client of clients.slice(1)) await enterRoom(client, room);
  clients[0].send('startGame', {});
  await clients[0].wait('gameStarted');

  // These connections send neither Close nor application Pong. No OS/socket
  // close notification is needed for the server to detect their disappearance.
  await Promise.all(clients.map(client => waitClosed(client)));
  await eventually(() => server.stats().rooms === 0 && server.stats().online === 1, 'silent room cleanup');
  assert.equal((await observer.wait('roomDeleted')).data, room.roomId);
  assert.equal(observer.closed, false);
  const returning = await connect(t, url, clients[0].account);
  returning.send('enterRoom', { roomId: room.roomId });
  assert.equal((await returning.wait('error')).data.code, 'no_room');
});

test('unanswered application Ping expires even while other frames keep arriving', async t => {
  const { server, url } = await startServer(t, { heartbeatIntervalMs: 50, idleTimeoutMs: 400 });
  const owner = await connect(t, url);
  const peer = await connect(t, url);
  answerHeartbeats(peer);
  const room = await createRoom(owner);
  await enterRoom(peer, room);
  const timestamp = (await owner.wait('Ping')).data;
  const traffic = setInterval(() => {
    if (owner.closed) return;
    owner.send('getRooms');
    owner.send('Pong', timestamp - 1);
    owner.ws.ping();
  }, 40);
  t.after(() => clearInterval(traffic));

  await waitClosed(owner);
  clearInterval(traffic);
  assert.equal((await peer.wait('playerDisconnected')).data, owner.account.playerId);
  assert.equal((await peer.wait('newRoomOwner')).data, peer.account.playerId);
  assert.equal(server.stats().online, 1);
  peer.send('getRooms');
  const remaining = (await peer.wait('onGetRooms')).data;
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0].players, [peer.account.playerId]);
  await peer.close();
  await eventually(() => server.stats().rooms === 0, 'last healthy member cleanup');
});
