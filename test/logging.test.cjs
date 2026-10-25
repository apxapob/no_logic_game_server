'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, stat, writeFile, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { RotatingFileLogger } = require('../dist/Logging.js');
const { defaults, resolveOptions, configFromEnv } = require('../dist/config.js');
const { startServer, connect, createRoom, enterRoom, rawClient, waitClosed, eventually, within } = require('./helpers.cjs');

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'no-logic-logs-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function snapshot(path) {
  const names = (await readdir(path)).filter(name => /^server-\d{20}\.jsonl$/.test(name)).sort();
  const contents = await Promise.all(names.map(name => readFile(join(path, name), 'utf8')));
  return { names, bytes: contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0),
    records: contents.flatMap(content => content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) };
}

test('verbose logs default off with a configurable 1 GiB total limit', () => {
  assert.equal(defaults.verboseLogs, false);
  assert.equal(defaults.logMaxBytes, 1024 ** 3);
  assert.equal(defaults.logFileMaxBytes, 16 * 1024 ** 2);
  const options = configFromEnv({ VERBOSE_LOGS: 'true', LOG_DIRECTORY: '/tmp/example', LOG_MAX_BYTES: '4294967296', LOG_FILE_MAX_BYTES: '4096' }, []);
  assert.equal(options.verboseLogs, true);
  assert.equal(options.logDirectory, '/tmp/example');
  assert.equal(options.logMaxBytes, 4 * 1024 ** 3);
  assert.equal(options.logFileMaxBytes, 4096);
  for (const key of ['LOG_MAX_BYTES', 'LOG_FILE_MAX_BYTES']) {
    for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992']) assert.throws(() => configFromEnv({ [key]: value }, []));
  }
  assert.throws(() => configFromEnv({ VERBOSE_LOGS: 'yes' }, []));
  assert.throws(() => resolveOptions({ logDirectory: ' ' }));
  assert.throws(() => resolveOptions({ verboseLogs: 'true' }));
});

test('rotation caps all files, preserves full Unicode records and retains the newest messages', async t => {
  const path = await directory(t);
  const logger = await RotatingFileLogger.open({ directory: path, maxBytes: 1024, fileMaxBytes: 300 });
  t.after(() => logger.close());
  await writeFile(join(path, 'unrelated.txt'), 'keep me');
  for (let id = 0; id < 40; id++) {
    logger.write(JSON.stringify({ id, text: '\u041f\u0440\u0438\u0432\u0435\u0442'.repeat(8) }));
    await logger.flush();
    assert.ok((await snapshot(path)).bytes <= 1024);
  }
  const result = await snapshot(path);
  assert.ok(result.names.length > 1);
  assert.ok(result.records[0].id > 0);
  assert.equal(result.records.at(-1).id, 39);
  assert.deepEqual(result.records.map(row => row.id), Array.from({ length: result.records.length }, (_, i) => 40 - result.records.length + i));
  assert.equal(await readFile(join(path, 'unrelated.txt'), 'utf8'), 'keep me');
  await logger.close();
});

test('restart reuses the budget, prunes previous runs and supports a lower limit', async t => {
  const path = await directory(t);
  let logger = await RotatingFileLogger.open({ directory: path, maxBytes: 4096, fileMaxBytes: 250 });
  for (let id = 0; id < 20; id++) logger.write(JSON.stringify({ id, text: 'x'.repeat(80) }));
  await logger.close();
  assert.ok((await snapshot(path)).bytes > 512);
  logger = await RotatingFileLogger.open({ directory: path, maxBytes: 512, fileMaxBytes: 250 });
  t.after(() => logger.close());
  assert.ok((await snapshot(path)).bytes <= 512);
  logger.write(JSON.stringify({ id: 20, text: 'latest' }));
  await logger.close();
  const result = await snapshot(path);
  assert.ok(result.bytes <= 512);
  assert.equal(result.records.at(-1).id, 20);
});

test('a record larger than a segment stays whole; a record larger than the total gets an explicit marker', async t => {
  const path = await directory(t);
  const logger = await RotatingFileLogger.open({ directory: path, maxBytes: 1024, fileMaxBytes: 100 });
  t.after(() => logger.close());
  logger.write(JSON.stringify({ text: 'x'.repeat(600) }));
  await logger.flush();
  assert.equal((await snapshot(path)).records[0].text.length, 600);
  logger.write(JSON.stringify({ text: 'x'.repeat(2000) }));
  await logger.close();
  const result = await snapshot(path);
  assert.ok(result.bytes <= 1024);
  assert.equal(result.records.at(-1).event, 'log.record_too_large');
});

test('close flushes a burst in order before returning', async t => {
  const path = await directory(t);
  const logger = await RotatingFileLogger.open({ directory: path, maxBytes: 1024 ** 2, fileMaxBytes: 4096 });
  for (let id = 0; id < 2000; id++) logger.write(JSON.stringify({ id }));
  await logger.close();
  assert.deepEqual((await snapshot(path)).records.map(row => row.id), Array.from({ length: 2000 }, (_, i) => i));
});

test('a producer faster than the disk has a bounded queue and reports lost records', async t => {
  const path = await directory(t);
  const logger = await RotatingFileLogger.open({ directory: path, maxBytes: 16 * 1024 ** 2, fileMaxBytes: 1024 ** 2 });
  for (let id = 0; id < 512; id++) logger.write(JSON.stringify({ id, text: 'x'.repeat(32768) }));
  await logger.close();
  const { records } = await snapshot(path);
  const dropped = records.filter(row => row.event === 'log.records_dropped').reduce((sum, row) => sum + row.count, 0);
  assert.ok(dropped > 0);
  assert.equal(records.filter(row => Number.isInteger(row.id)).length + dropped, 512);
});

test('file write errors notify once and do not escape the synchronous game logger', async t => {
  const path = await directory(t);
  let errors = 0;
  const logger = await RotatingFileLogger.open({ directory: path, maxBytes: 1024, fileMaxBytes: 100, onError: () => errors++ });
  // Occupy the next managed filename with a directory to force a real open failure.
  await mkdir(join(path, 'server-00000000000000000001.jsonl'));
  assert.doesNotThrow(() => logger.write('{"event":"test"}'));
  await assert.rejects(logger.flush());
  assert.equal(errors, 1);
  assert.doesNotThrow(() => logger.write('{"event":"ignored"}'));
  await assert.rejects(logger.close());
  assert.equal(errors, 1);
});

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

test('startup removes only managed regular log files', async t => {
  const path = await directory(t);
  await writeFile(join(path, 'server-00000000000000000001.jsonl'), 'x'.repeat(2000));
  await writeFile(join(path, 'keep.log'), 'untouched');
  await mkdir(join(path, 'server-00000000000000000002.jsonl'));
  const logger = await RotatingFileLogger.open({ directory: path, maxBytes: 1024, fileMaxBytes: 100 });
  await logger.close();
  assert.equal(await readFile(join(path, 'keep.log'), 'utf8'), 'untouched');
  assert.ok((await stat(join(path, 'server-00000000000000000002.jsonl'))).isDirectory());
  assert.equal((await readdir(path)).includes('server-00000000000000000001.jsonl'), false);
});

test('real CLI writes rotating files from environment settings without duplicating messages to stdout', async t => {
  const path = await mkdtemp(join(tmpdir(), 'no-logic-cli-logs-'));
  const child = spawn(process.execPath, [join(__dirname, '../dist/index.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', VERBOSE_LOGS: 'true', LOG_DIRECTORY: path,
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
