'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { rawClient, createRoom, enterRoom } = require('../test/helpers.cjs');
const url = process.argv[2];
if (!url || new URL(url).protocol !== 'wss:') throw new Error('Pass an authorized WSS endpoint');
const cleanups = [];
const context = { after: fn => cleanups.push(fn) };
async function connect(account) {
  const client = rawClient(context, url, { origin: 'https://apxapob.com', handshakeTimeout: 15000 });
  const wait = client.wait.bind(client);
  client.wait = (method, predicate = () => true, timeout = 15000) => wait(method, predicate, timeout);
  client.ws.on('message', (bytes, binary) => {
    if (!binary) {
      const msg = JSON.parse(bytes.toString());
      if (msg.method === 'Ping') client.send('Pong', msg.data);
    }
  });
  await client.opened;
  client.send('authenticate', account || { name: 'Rust deployment smoke' });
  client.account = account || (await client.wait('accountCreated')).data;
  await client.wait('onConnected');
  return client;
}
async function main() {
  const host = await connect(), peer = await connect(), third = await connect();
  const room = await createRoom(host, { name: 'Temporary deployment check', binaryRelay: true });
  await enterRoom(peer, room); await enterRoom(third, room);
  host.send('sendTo', { to: [peer.account.playerId], msg: { check: 'json' } });
  assert.equal((await peer.wait('messageFromPlayer')).data.msg.check, 'json');
  const payload = randomBytes(32000);
  function packet(target) {
    const b = Buffer.alloc(17 + payload.length); b[0] = 1;
    if (target) Buffer.from(target.replaceAll('-', ''), 'hex').copy(b, 1);
    payload.copy(b, 17); return b;
  }
  host.ws.send(packet(peer.account.playerId));
  const targeted = (await peer.wait('binary')).data;
  assert.equal(targeted.subarray(1, 17).toString('hex'), host.account.playerId.replaceAll('-', ''));
  assert.deepEqual(targeted.subarray(17), payload);
  host.ws.send(packet(null));
  for (const client of [peer, third]) assert.deepEqual((await client.wait('binary')).data.subarray(17), payload);
  host.send('startGame', { fixedRoster: true, hostMigration: true });
  await peer.wait('gameStarted'); await host.close();
  assert.equal((await peer.wait('newRoomOwner')).data.playerId, peer.account.playerId);
  const resumed = await connect(host.account);
  const restored = await enterRoom(resumed, room);
  assert.equal(restored.hostGeneration, 1);
  for (const client of [peer, third, resumed]) client.send('leaveRoom');
  await resumed.barrier(); await peer.barrier(); await third.barrier();
  const legacy = await createRoom(peer, { name: 'Temporary legacy check' });
  await enterRoom(third, legacy);
  const raw = Buffer.concat([Buffer.from([0xf8]), payload]);
  peer.ws.send(raw); assert.deepEqual((await third.wait('binary')).data, raw);
  peer.send('leaveRoom'); third.send('leaveRoom');
  await peer.barrier(); await third.barrier();
  console.log(JSON.stringify({ time: new Date().toISOString(), json: true, targetedBinary: true, broadcastBinary: true, legacyBinary: true, hostMigration: true, rejoin: true, roomsLeft: true }));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { for (const close of cleanups.reverse()) await close(); });
