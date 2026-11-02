'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { startServer, connect, createRoom, enterRoom, rawClient, waitClosed, eventually, within } = require('./helpers.cjs');


async function snapshot(path) {
  const names = (await readdir(path)).filter(name => /^server-\d{20}\.jsonl$/.test(name)).sort();
  const contents = await Promise.all(names.map(name => readFile(join(path, name), 'utf8')));
  return { names, bytes: contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0),
    records: contents.flatMap(content => content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) };
}

test('verbose WebSocket logs cover lifecycle, bidirectional JSON/binary/control frames and redact credentials', async t => {
  const lines = [];
  const { server, url } = await startServer(t, { verboseLogs: true, logger: line => lines.push(line) });
  const owner = await connect(t, url, { name: 'Owner' });
  const peer = await connect(t, url);
  const room = await createRoom(owner, { password: 'private-room-password' });
  await enterRoom(peer, room, 'private-room-password');
  owner.send('sendToRoom', { text: 'hello', nested: [{ accessToken: 'hidden-token' }], password: 'hidden-payload-password' });
  const delivered = (await peer.wait('messageFromPlayer')).data.msg;
  assert.equal(delivered.nested[0].accessToken, 'hidden-token', 'redaction must not mutate traffic');
  const binary = Buffer.from([0, 1, 255, 128]);
  owner.ws.send(binary);
  await peer.wait('binary');
  const pong = once(owner.ws, 'pong');
  owner.ws.ping('probe');
  await pong;
  const replacement = await connect(t, url, owner.account);
  await waitClosed(owner);
  await replacement.close();
  await peer.close();
  await server.stop();
  const logs = lines.map(line => JSON.parse(line));
  for (const event of ['transport.connected', 'connection.connected', 'authentication.succeeded', 'room.created', 'room.entered', 'room.left', 'room.deleted', 'connection.disconnected', 'server stopped']) {
    assert.ok(logs.some(log => log.event === event), event);
  }
  const connected = logs.find(log => log.event === 'connection.connected');
  const authenticated = logs.find(log => log.event === 'authentication.succeeded');
  assert.equal(connected.connectionId, authenticated.connectionId);
  assert.equal(authenticated.playerId, owner.account.playerId);
  assert.ok(logs.every(log => Number.isFinite(Date.parse(log.time))));
  for (const direction of ['in', 'out']) {
    assert.ok(logs.some(log => log.event === 'message' && log.direction === direction && log.type === 'binary' && log.payload === binary.toString('base64')));
    assert.ok(logs.some(log => log.event === 'message' && log.direction === direction && log.type === 'text' && JSON.stringify(log.payload).includes('hello')));
  }
  assert.ok(logs.some(log => log.type === 'ping' && log.direction === 'in'));
  assert.ok(logs.some(log => log.type === 'pong' && log.direction === 'out'));
  assert.ok(logs.some(log => log.reason === 'session_replaced'));
  for (const secret of [owner.account.password, peer.account.password, 'private-room-password', 'hidden-token', 'hidden-payload-password']) {
    assert.equal(lines.join('\n').includes(secret), false, 'secret must be redacted');
  }
  assert.ok(lines.join('\n').includes('[REDACTED]'));
});

test('rejections, invalid JSON, rate limits and authentication timeout have diagnostic reasons without URL secrets', async t => {
  const logs = [];
  const { server, url } = await startServer(t, { verboseLogs: true, maxMessagesPerSecond: 3, authTimeoutMs: 100, logger: line => logs.push(JSON.parse(line)) });
  await waitClosed(rawClient(t, url + '?password=query-secret'));
  const pending = rawClient(t, url);
  await pending.opened;
  pending.ws.send('{"password":"malformed-secret",');
  await pending.wait('error');
  await waitClosed(pending);
  const flood = await connect(t, url);
  for (let i = 0; i < 4; i++) flood.send('getRooms');
  await waitClosed(flood);
  const denied = rawClient(t, url);
  await denied.opened;
  denied.send('authenticate', { playerId: flood.account.playerId, password: 'incorrect-secret' });
  await denied.wait('wrongPassword');
  await waitClosed(denied);
  await server.stop();
  for (const reason of ['invalid_path', 'authentication_timeout', 'message_rate_limit']) assert.ok(logs.some(log => log.reason === reason), reason);
  assert.ok(logs.some(log => log.event === 'authentication.failed'));
  assert.ok(logs.some(log => log.event === 'protocol.error' && log.code === 'invalid_message'));
  for (const secret of ['query-secret', 'malformed-secret', 'incorrect-secret']) assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('normal mode keeps lifecycle-only logging and a broken sink cannot stop game traffic', async t => {
  const logs = [];
  const normal = await startServer(t, { logger: text => logs.push(text) });
  const client = await connect(t, normal.url);
  await client.close();
  await normal.server.stop();
  assert.deepEqual(logs, ['server started', 'server stopped']);
  const broken = await startServer(t, { verboseLogs: true, logger: () => { throw new Error('sink failed'); } });
  const other = await connect(t, broken.url);
  await createRoom(other);
  await eventually(() => broken.server.stats().rooms === 1, 'game works without logger');
});

test('real CLI writes rotating files from environment settings without duplicating messages to stdout', async t => {
  const path = await mkdtemp(join(tmpdir(), 'no-logic-cli-logs-'));
  const child = spawn(require('./rust-server.cjs').binary, [], {
    env: { ...process.env, SESSION_DIRECTORY: '', TELEMETRY_ENABLED: 'false', HOST: '127.0.0.1', PORT: '0', VERBOSE_LOGS: 'true', LOG_DIRECTORY: path,
      LOG_MAX_BYTES: '4096', LOG_FILE_MAX_BYTES: '512', ALLOW_NO_ORIGIN: 'true', SEND_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await within(exited, 'CLI cleanup');
    await rm(path, { recursive: true, force: true });
  });
  let port;
  await eventually(async () => {
    assert.equal(child.exitCode, null, output);
    try {
      port = (await snapshot(path)).records.find(row => row.event === 'server.listening')?.address.port;
      return !!port;
    } catch { return false; }
  }, 'CLI listening event');
  const client = await connect(t, `ws://127.0.0.1:${port}/`);
  await createRoom(client);
  for (let i = 0; i < 30; i++) client.send('getRooms');
  await client.barrier();
  await client.close();
  await eventually(async () => {
    try { return (await snapshot(path)).records.some(row => row.event === 'connection.disconnected'); }
    catch { return false; }
  }, 'CLI flush after real traffic');
  if (process.platform === 'win32') child.kill('SIGKILL');
  else child.kill('SIGTERM');
  await within(exited, 'CLI exit');
  const result = await snapshot(path);
  assert.ok(result.bytes <= 4096);
  assert.ok(result.names.length > 1);
  assert.ok(result.records.some(row => row.event === 'message'));
  assert.ok(result.records.every(row => row.event !== 'server.listening'), 'older startup logs should be rotated away');
  assert.equal(output, '', 'verbose stream belongs only in bounded files');
  if (process.platform !== 'win32') assert.equal(result.records.at(-1).event, 'server stopped');
});
