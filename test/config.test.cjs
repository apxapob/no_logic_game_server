'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configFromEnv } = require('../dist/config.js');

// Explicit environment/argv arguments keep these tests isolated from the runner's
// process environment. The implementation contract does not require NODE_ENV.
const numericSettings = [
  'SEND_DELAY_MS', 'MAX_PAYLOAD_BYTES', 'MAX_BUFFERED_BYTES',
  'MAX_CONNECTIONS', 'MAX_CONNECTIONS_PER_IP', 'MAX_ACCOUNTS', 'MAX_ROOMS',
  'MAX_ROOM_PLAYERS', 'MAX_MESSAGES_PER_SECOND', 'MAX_CONNECTIONS_PER_MINUTE',
  'ACCOUNT_TTL_MS', 'HEARTBEAT_INTERVAL_MS', 'IDLE_TIMEOUT_MS',
  'AUTH_TIMEOUT_MS', 'MAINTENANCE_INTERVAL_MS', 'SHUTDOWN_TIMEOUT_MS',
];

function config(env = {}, argv = []) { return configFromEnv(env, argv); }

test('configuration loads without NODE_ENV and permits ephemeral port and zero delay', () => {
  const options = config({ HOST: '127.0.0.1', PORT: '0', SEND_DELAY_MS: '0' });
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 0);
  assert.equal(options.sendDelayMs, 0);
});

test('configuration parses all documented numeric limits', () => {
  const env = Object.fromEntries(numericSettings.map(key => [key, '123']));
  const options = config(env);
  for (const key of numericSettings) {
    const camelCase = key.toLowerCase().replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    assert.equal(options[camelCase], 123, key);
  }
});

test('numeric environment values reject nonfinite, fractional, negative and partial inputs', () => {
  for (const key of ['PORT', ...numericSettings]) {
    for (const value of ['NaN', 'Infinity', '-1', '1.5', '12ms', '']) {
      assert.throws(() => config({ [key]: value }), undefined, `${key}=${JSON.stringify(value)}`);
    }
  }
  for (const value of ['65536', '1000000000000000000000']) {
    assert.throws(() => config({ PORT: value }));
  }
  for (const key of numericSettings.filter(key => key !== 'SEND_DELAY_MS')) {
    assert.throws(() => config({ [key]: '0' }), undefined, `${key} must be positive`);
  }
});

test('boolean configuration accepts true/false and rejects ambiguous values', () => {
  for (const [key, property] of [['ALLOW_NO_ORIGIN', 'allowNoOrigin'], ['DEV_MODE', 'devMode']]) {
    assert.equal(config({ [key]: 'true' })[property], true);
    assert.equal(config({ [key]: 'false' })[property], false);
    for (const value of ['1', '0', 'yes', 'no', '']) {
      assert.throws(() => config({ [key]: value }), undefined, `${key}=${JSON.stringify(value)}`);
    }
  }
});

test('allowed origins CSV trims entries and native-client policy is explicit', () => {
  const options = config({ ALLOWED_ORIGINS: 'https://one.example, https://two.example', ALLOW_NO_ORIGIN: 'false' });
  assert.deepEqual(options.allowedOrigins, ['https://one.example', 'https://two.example']);
  assert.equal(options.allowNoOrigin, false);
});

test('legacy CLI dev and delay=N remain supported, invalid delays fail', () => {
  assert.equal(config({}, ['dev', 'delay=25']).devMode, true);
  assert.equal(config({}, ['dev', 'delay=25']).sendDelayMs, 25);
  for (const value of ['NaN', '-1', '1.5', 'abc', 'Infinity']) {
    assert.throws(() => config({}, [`delay=${value}`]));
  }
});
