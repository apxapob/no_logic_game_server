'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Telemetry, telemetryFromEnv } = require('../dist/Telemetry.js');
const { resolveOptions } = require('../dist/config.js');
const { startServer, connect, createRoom, enterRoom } = require('./helpers.cjs');

const env = { TELEMETRY_URL: 'https://telemetry.example.com/v1/events', TELEMETRY_WRITE_KEY: 'test-project-key-not-a-real-secret' };
const stats = { accounts: 2, online: 1, rooms: 1, pendingConnections: 0 };
function recorder(options = {}) {
  const sent = [];
  const telemetry = new Telemetry(telemetryFromEnv(env), { transport: async (url, key, body, signal) => {
    sent.push({ url, key, body, signal }); return 202;
  }, ...options });
  return { telemetry, sent, events: () => sent.flatMap(item => JSON.parse(item.body).events) };
}

test('telemetry is disabled without configuration; URL and key validation require HTTPS without credentials or query', async () => {
  let calls = 0;
  const telemetry = new Telemetry(telemetryFromEnv({}), { transport: () => { calls++; throw Error('must not run'); } });
  telemetry.start(() => stats);
  telemetry.observe('room.created', { secret: 'never' });
  telemetry.sample(stats);
  telemetry.capture('server.fatal', new Error('secret'));
  await telemetry.flush(); await telemetry.close();
  assert.equal(calls, 0);
  assert.equal(telemetry.status().queued, 0);
  assert.equal(telemetryFromEnv({ TELEMETRY_URL: env.TELEMETRY_URL }).url, null);
  for (const url of ['http://telemetry.example.com/', 'https://user:pass@example.com/', 'https://example.com/?token=x', 'https://example.com/#secret', 'broken']) {
    assert.throws(() => telemetryFromEnv({ ...env, TELEMETRY_URL: url }));
  }
  for (const key of ['short', 'x'.repeat(257), 'a'.repeat(30) + '\r\nsecret']) assert.throws(() => telemetryFromEnv({ ...env, TELEMETRY_WRITE_KEY: key }));
  assert.throws(() => telemetryFromEnv({ ...env, TELEMETRY_INTERVAL_MS: '0' }));
  assert.throws(() => telemetryFromEnv({ ...env, TELEMETRY_PROJECT: 'player email@example.com' }));
  assert.throws(() => resolveOptions({ telemetry: 'not a callback' }));
});

test('explicit telemetry kill switch overrides valid and invalid unused settings without any outbound calls', async () => {
  for (const settings of [env, {
    TELEMETRY_URL: 'not a URL', TELEMETRY_WRITE_KEY: 'invalid', TELEMETRY_PROJECT: 'not valid',
    TELEMETRY_RELEASE: 'invalid release', TELEMETRY_INTERVAL_MS: '-1', TELEMETRY_TIMEOUT_MS: 'NaN',
  }]) {
    let calls = 0;
    const options = telemetryFromEnv({ ...settings, TELEMETRY_ENABLED: 'false' });
    assert.equal(options.url, null); assert.equal(options.writeKey, '');
    const telemetry = new Telemetry(options, { transport: async () => { calls++; return 202; } });
    telemetry.start(() => stats); telemetry.observe('room.created'); telemetry.sample(stats);
    telemetry.capture('server.fatal', new Error('unused'));
    await telemetry.flush(true); await telemetry.close();
    assert.equal(calls, 0); assert.equal(telemetry.status().queued, 0);
  }
  for (const value of ['yes', '0', 'FALSE', '']) assert.throws(() => telemetryFromEnv({ ...env, TELEMETRY_ENABLED: value }));
  assert.throws(() => telemetryFromEnv({ TELEMETRY_ENABLED: 'true' }));
  assert.throws(() => telemetryFromEnv({ TELEMETRY_ENABLED: 'true', TELEMETRY_URL: env.TELEMETRY_URL }));
  assert.equal(telemetryFromEnv({ ...env, TELEMETRY_ENABLED: 'true' }).url, env.TELEMETRY_URL);
});

test('activity and error allowlists discard payloads, identifiers, IPs, paths and attacker-controlled close reasons', async () => {
  const { telemetry, sent, events } = recorder();
  const secret = 'private-account-password';
  telemetry.observe('connection.connected', { playerId: secret, ip: '192.0.2.123' });
  telemetry.observe('connection.disconnected', { reason: secret, code: 1000 });
  telemetry.observe('message', { payload: { password: secret, chat: secret } });
  telemetry.observe('room.created', { name: secret, ownerId: secret });
  telemetry.observe('protocol.error', { code: secret });
  telemetry.observe('connection.terminate', { reason: 'message_rate_limit' });
  telemetry.observe('connection.terminate', { reason: secret });
  const error = new Error(`password=${secret} https://example.com/?token=${secret}`);
  error.stack = `${error.message}\n    at parse (C:\\Users\\${secret}\\src\\Server.js:42:9)\n    at ${secret} (https://example.com/?token=${secret})`;
  telemetry.capture('server.fatal', error);
  telemetry.capture(`server.${secret}`, error);
  telemetry.sample(stats);
  await telemetry.flush();
  const body = sent.map(item => item.body).join('');
  assert.ok(!body.includes(secret)); assert.ok(!body.includes('192.0.2.123')); assert.ok(!body.includes('C:\\Users'));
  assert.equal(JSON.parse(sent[0].body).project, 'no-logic');
  const activity = events().find(event => event.name === 'server.activity');
  assert.equal(activity.properties.connections, 1);
  assert.equal(activity.properties.disconnects, 1);
  assert.equal(activity.properties.roomsCreated, 1);
  assert.equal(activity.properties.protocolErrors, 1);
  assert.equal(activity.properties.rateLimits, 1);
  assert.equal(activity.properties.terminated, 2);
  const fatal = events().find(event => event.name === 'server.fatal');
  assert.deepEqual(fatal.error, { name: 'Error', message: 'server.fatal', stack: 'at Server.js:42:9' });
  assert.ok(events().every(event => event.sessionId === fatal.sessionId));
  await telemetry.close();
});

test('an outage retains bounded memory, uses backoff, retries the same IDs and respects batch/body caps', async () => {
  let now = Date.now(); let fail = true; const sent = [];
  const telemetry = new Telemetry(telemetryFromEnv(env), { now: () => now, transport: async (_url, _key, body) => {
    sent.push(JSON.parse(body)); if (fail) throw Error('offline'); return 202;
  } });
  telemetry.sample(stats);
  await telemetry.flush();
  assert.equal(telemetry.status().failures, 1);
  await telemetry.flush(); assert.equal(sent.length, 1);
  now += 1000; fail = false;
  await telemetry.flush();
  assert.equal(sent[0].events[0].id, sent[1].events[0].id);
  for (let i = 0; i < 1000; i++) telemetry.sample(stats);
  assert.equal(telemetry.status().queued, 256);
  assert.ok(telemetry.status().queuedBytes <= 512 * 1024);
  assert.ok(telemetry.status().dropped >= 744);
  await telemetry.flush();
  assert.equal(sent.at(-1).events.length, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(sent.at(-1))) <= 64 * 1024);
  await telemetry.close();
});

test('concurrent flushes share the request and events arriving in flight survive retry', async () => {
  let finish;
  const { telemetry } = recorder({ transport: (_url, _key, _body, signal) => new Promise((resolve, reject) => {
    finish = resolve;
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) });
  telemetry.sample(stats);
  const first = telemetry.flush();
  assert.equal(first, telemetry.flush());
  telemetry.sample(stats);
  finish(503); await first;
  assert.equal(telemetry.status().queued, 2);
  await telemetry.close(10);
  assert.equal(telemetry.status().queued, 0);
});

test('error floods are coalesced, permanent rejects are dropped and shutdown aborts a stalled request', async () => {
  let now = Date.now(); let calls = 0;
  const telemetry = new Telemetry(telemetryFromEnv(env), { now: () => now, transport: async () => { calls++; return 401; } });
  for (let i = 0; i < 1000; i++) telemetry.capture('server.http_error');
  assert.equal(telemetry.status().queued, 1);
  await telemetry.flush();
  assert.equal(telemetry.status().queued, 0); assert.equal(telemetry.status().dropped, 1);
  telemetry.sample(stats); await telemetry.flush(); assert.equal(calls, 1);
  now += 60000; await telemetry.flush(); assert.equal(calls, 2);
  await telemetry.close();
  let signal;
  const stalled = recorder({ transport: (_url, _key, _body, abortSignal) => {
    signal = abortSignal;
    return new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
  } }).telemetry;
  stalled.sample(stats); void stalled.flush();
  const before = Date.now(); await stalled.close(20);
  assert.ok(Date.now() - before < 500); assert.equal(signal.aborted, true);
});

test('relay diagnostics work with verbose logging disabled and preserve the existing logger', async t => {
  const { telemetry, events } = recorder(); const logs = [];
  t.after(() => telemetry.close());
  const { server, url } = await startServer(t, { verboseLogs: false, logger: line => logs.push(line), telemetry: (event, details) => telemetry.observe(event, details) });
  telemetry.start(() => server.stats());
  const owner = await connect(t, url, { name: 'private-owner-name' });
  const peer = await connect(t, url, { name: 'private-peer-name' });
  const room = await createRoom(owner); await enterRoom(peer, room);
  telemetry.sample(server.stats()); await telemetry.flush();
  assert.ok(logs.includes('server started'));
  const activity = events().filter(event => event.name === 'server.activity');
  assert.equal(activity.reduce((sum, event) => sum + (event.properties.roomsCreated ?? 0), 0), 1);
  assert.equal(activity.reduce((sum, event) => sum + (event.properties.connections ?? 0), 0), 2);
  const json = JSON.stringify(events());
  for (const privateValue of [owner.account.playerId, owner.account.password, 'private-owner-name', room.roomId]) assert.ok(!json.includes(privateValue));
});

test('throwing telemetry observers do not change server lifecycle or protocol behavior', async t => {
  const { url } = await startServer(t, { telemetry: () => { throw Error('broken observer'); } });
  const owner = await connect(t, url); const room = await createRoom(owner);
  assert.ok(room.roomId);
});

test('CLI registers a fatal monitor without suppressing the original process crash', async () => {
  const child = spawn(process.execPath, ['-e', `require('./dist/index').main().then(() => { throw new Error('test fatal'); })`], {
    cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TELEMETRY_ENABLED: 'false', TELEMETRY_URL: '', TELEMETRY_WRITE_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  assert.equal(result, 1); assert.match(stderr, /test fatal/);
});
