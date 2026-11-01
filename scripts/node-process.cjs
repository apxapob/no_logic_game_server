'use strict';
// Same CLI imports/configuration as npm start, with a local stdin shutdown hook
// for reproducible Windows/Linux experiments (no public control endpoint).
const { Server, configFromEnv } = require('../dist/index');
const server = new Server(configFromEnv());
server.start().then(() => console.log(JSON.stringify({ event: 'server.listening', address: server.address() })));
require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
  if (line === 'stop') { await server.stop(); process.exit(0); }
});
