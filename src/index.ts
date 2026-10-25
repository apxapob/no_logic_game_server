import { Server } from './Server';
import { configFromEnv, resolveOptions } from './config';
import { RotatingFileLogger } from './Logging';
export { Server } from './Server';
export { configFromEnv } from './config';
export { RotatingFileLogger } from './Logging';
export async function main(): Promise<void> {
  const options = resolveOptions(configFromEnv());
  const files = options.verboseLogs ? await RotatingFileLogger.open({
    directory: options.logDirectory, maxBytes: options.logMaxBytes,
    fileMaxBytes: options.logFileMaxBytes,
    onError: () => console.error('File logging failed; detailed logging disabled. Check disk space and permissions.'),
  }) : null;
  const server = new Server({ ...options, logger: text => { if (files) files.write(text); else console.log(text); } });
  const shutdown = (): void => {
    void server.stop().then(() => files?.close()).catch(() => { console.error('Server shutdown or log flush failed'); process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try { await server.start(); }
  catch {
    process.exitCode = 1;
    console.error('Server startup failed');
    await server.stop();
    await files?.close();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}
if (require.main === module) {
  void main().catch(() => { console.error('Server configuration failed'); process.exitCode = 1; });
}
