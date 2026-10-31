'use strict';
const { Server } = require('../../dist/Server');
const server = new Server({ host: '127.0.0.1', port: 0, sessionDirectory: process.argv[2] });
server.start().then(() => process.send({ url: `ws://127.0.0.1:${server.address().port}/` }));
