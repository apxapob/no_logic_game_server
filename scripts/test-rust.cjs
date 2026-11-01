'use strict';
const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const files = readdirSync('test').filter(name => name.endsWith('.test.cjs')).map(name => 'test/' + name);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { env: { ...process.env, RELAY_BACKEND: 'rust' }, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
