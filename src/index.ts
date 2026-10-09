import { Server } from './Server';
import { configFromEnv } from './config';
export { Server } from './Server';
export { configFromEnv } from './config';
export async function main(): Promise<void> {
  const server = new Server({ ...configFromEnv(), logger: text => console.log(text) });
  const shutdown = (): void => {
    void server.stop().catch(() => { console.error('Server shutdown failed'); process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try { await server.start(); }
  catch {
    process.exitCode = 1;
    console.error('Server startup failed');
    await server.stop();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}
if (require.main === module) {
  void main().catch(() => { console.error('Server configuration failed'); process.exitCode = 1; });
}
