'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startServer, connect, createRoom, enterRoom, eventually } = require('./helpers.cjs');
async function expectError(client, code) {
  assert.equal((await client.wait('error')).data.code, code);
}

test('each device gets its chosen game language, including a changed preference and fallback', async t => {
  const sent = [];
  const { host, guest } = await setup(t, async (token, notification) => { sent.push({ token, ...notification }); return 'sent'; });
  const locales = ['en', 'ru', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'zh-CN'];
  // Four devices on one account may have different preferences.
  const deviceIds = Array.from({ length: 4 }, () => randomUUID());
  for (let i = 0; i < 4; i++) {
    guest.send('setPushDevice', { deviceId: deviceIds[i], token: `${token}-${i}`, foreground: false,
      language: ['en', 'de', 'pt-BR', 'it'][i] });
    await guest.wait('pushDeviceUpdated');
  }
  guest.send('setPushDevice', { deviceId: deviceIds[0], token: `${token}-0`, foreground: false, language: 'ru' });
  await guest.wait('pushDeviceUpdated');
  host.send('notifyPlayers', { to: [guest.account.playerId], eventId: 'turn.localized', title: 'Default', body: 'Fallback',
    translations: Object.fromEntries(locales.map(language => [language, { title: `Title ${language}`, body: `Body ${language}` }])) });
  await eventually(() => sent.length === 4);
  assert.deepEqual(sent.map(message => message.body), ['Body ru', 'Body de', 'Body pt-BR', 'Fallback']);
  assert.ok(sent.every(message => !('bodyLocKey' in message)));
  guest.send('setPushDevice', { deviceId: deviceIds[0], token, foreground: false, language: '../ru' });
  await expectError(guest, 'invalid_message');
});
const token = 'test-token-123456789012345678901234567890';
async function register(client, foreground = false, value = token, deviceId = randomUUID()) {
  client.send('setPushDevice', { deviceId, token: value, foreground });
  await client.wait('pushDeviceUpdated');
  return deviceId;
}
async function setup(t, pushSender) {
  const { url } = await startServer(t, { pushSender });
  const host = await connect(t, url);
  const guest = await connect(t, url);
  const outsider = await connect(t, url);
  const room = await createRoom(host);
  await enterRoom(guest, room);
  host.send('startGame', { fixedRoster: true, hostMigration: true });
  await host.wait('gameStarted');
  return { host, guest, outsider, room };
}
function notify(host, guest, eventId = 'turn.1') {
  host.send('notifyPlayers', { to: [guest.account.playerId], eventId, title: 'General', body: 'New turn' });
}
test('push only goes to background members, is deduplicated, and tokens never appear in DTOs/logs', async t => {
  const sent = [], logs = [];
  const { url } = await startServer(t, { verboseLogs: true, logger: text => logs.push(text),
    pushSender: async (...args) => { sent.push(args); return 'sent'; } });
  const host = await connect(t, url), guest = await connect(t, url);
  const room = await createRoom(host);
  await enterRoom(guest, room);
  await register(guest);
  host.send('startGame', { fixedRoster: true });
  await host.wait('gameStarted');
  notify(host, guest);
  await eventually(() => sent.length === 1);
  assert.equal(sent[0][0], token);
  assert.equal(sent[0][1].roomId, room.roomId);
  notify(host, guest);
  await host.barrier();
  assert.equal(sent.length, 1);
  host.send('getPlayers', [guest.account.playerId]);
  assert.equal(JSON.stringify((await host.wait('onGetPlayers')).data).includes(token), false);
  assert.equal(logs.join('\n').includes(token), false);
  notify(host, guest, 'turn.2');
  await expectError(host, 'push_rate_limited');
});
test('push cannot be sent by a guest or to players outside the fixed roster', async t => {
  const sent = [];
  const { host, guest, outsider } = await setup(t, async (...args) => { sent.push(args); return 'sent'; });
  await register(outsider);
  notify(guest, host);
  await expectError(guest, 'not_room_owner');
  notify(host, outsider);
  await expectError(host, 'invalid_message');
  assert.equal(sent.length, 0);
});
test('foreground and revoked devices are skipped; rotation replaces the previous token', async t => {
  for (const scenario of ['foreground', 'revoked', 'rotated']) {
    const sent = [];
    const { host, guest } = await setup(t, async (...args) => { sent.push(args); return 'sent'; });
    const id = await register(guest, scenario === 'foreground');
    if (scenario === 'revoked') await register(guest, false, null, id);
    if (scenario === 'rotated') await register(guest, false, `${token}-new`, id);
    notify(host, guest);
    await host.barrier();
    assert.deepEqual(sent.map(args => args[0]), scenario === 'rotated' ? [`${token}-new`] : []);
  }
});
test('disconnected fixed-roster players can receive push; failures do not break the relay', async t => {
  let attempts = 0;
  const { host, guest } = await setup(t, async () => { attempts++; throw new Error('provider failed'); });
  await register(guest, true);
  await guest.close();
  await host.wait('playerDisconnected');
  notify(host, guest);
  await eventually(() => attempts === 1);
  await host.barrier();
});
test('push capability is absent without a sender and malformed tokens are rejected', async t => {
  const { url } = await startServer(t);
  const client = await connect(t, url);
  client.send('setPushDevice', { deviceId: randomUUID(), token: 'bad\n', foreground: false });
  await expectError(client, 'invalid_message');
  client.send('setPushDevice', { deviceId: randomUUID(), token, foreground: false });
  await expectError(client, 'push_unavailable');
});
