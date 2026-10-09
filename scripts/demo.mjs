import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Explicit allowlist: never map request paths onto repository filesystem paths.
const demo = new URL('../demo.html', import.meta.url);
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (request.url !== '/' && request.url !== '/demo.html') {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(demo);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500).end();
  }
});
server.on('error', error => {
  console.error(`Demo server failed: ${error.code ?? 'unknown error'}`);
  process.exitCode = 1;
});
server.listen(8081, '127.0.0.1', () => console.log('Demo: http://127.0.0.1:8081'));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
