'use strict';
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
const mode = process.argv[2];
const steps = mode === 'lint' ? [[process.execPath, ['tools/node_modules/eslint/bin/eslint.js', '--config', 'tools/eslint.config.mjs', 'test', 'scripts', 'tools']]] : mode === 'check' ? [['cargo', ['fmt', '--check']], ['cargo', ['clippy', '--all-targets', '--locked', '--', '-D', 'warnings']], ['cargo', ['test', '--locked']], ['cargo', ['build', '--locked']], [process.execPath, ['scripts/test-rust.cjs']]] : mode === 'test' ? [['cargo', ['test', '--locked']], ['cargo', ['build', '--locked']], [process.execPath, ['scripts/test-rust.cjs']]] : mode === 'memory' ? [[process.execPath, ['scripts/memory-churn.cjs']]] : null;
if (!steps) throw new Error('Expected check, test or memory');
for (const [command, args] of steps) {
 const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status ?? 1);
}
