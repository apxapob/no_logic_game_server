'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { binary } = require('./rust-server.cjs');
function run(env = {}, args = []) {
  const result = spawnSync(binary, args, { input: 'stop\n', encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', SESSION_DIRECTORY: '', VERBOSE_LOGS: 'false', FCM_ENABLED: 'false', TELEMETRY_ENABLED: 'false', ...env } });
  if (result.error) throw result.error;
  return result;
}
test('Rust CLI rejects malformed numeric limits and boolean settings', () => {
  for (const [key, values] of Object.entries({ PORT: ['-1', '65536', '1.5', '80x', 'NaN', ''], MAX_CONNECTIONS: ['0', '-1', '3.5', '1x'], ALLOW_NO_ORIGIN: ['yes', '1', ''], VERBOSE_LOGS: ['TRUE'], MAX_SESSION_BYTES: ['2147483648'], SEND_DELAY_MS: ['-1'] })) {
    for (const value of values) assert.notEqual(run({ [key]: value }).status, 0, `${key}=${value}`);
  }
});
test('Rust CLI accepts zero port/delay, native origin policy and legacy flags', () => {
  for (const [env, args] of [[{ SEND_DELAY_MS: '0', ALLOW_NO_ORIGIN: 'false', ALLOWED_ORIGINS: ' https://game.example.com, http://localhost:8081 ' }, []], [{}, ['dev', 'delay=0']]]) {
    const result = run(env, args); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /server.listening/);
  }
  for (const arg of ['delay=', 'delay=-1', 'delay=1.5', 'delay=1x']) assert.notEqual(run({}, [arg]).status, 0, arg);
});
test('Rust CLI validates Origins and telemetry while the kill switch ignores unused settings', () => {
  for (const origin of ['null', 'https://game.example.com/path', 'ftp://example.com']) assert.notEqual(run({ ALLOWED_ORIGINS: origin }).status, 0);
  const invalid = { TELEMETRY_URL: 'http://invalid.example/path?secret=x', TELEMETRY_WRITE_KEY: 'unused', TELEMETRY_INTERVAL_MS: 'bad' };
  assert.equal(run({ ...invalid, TELEMETRY_ENABLED: 'false' }).status, 0);
  assert.notEqual(run({ ...invalid, TELEMETRY_ENABLED: 'true' }).status, 0);
});
