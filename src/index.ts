import { Server } from './Server';
import { configFromEnv, resolveOptions } from './config';
import { RotatingFileLogger } from './Logging';
import { Telemetry, telemetryFromEnv } from './Telemetry';
import { createPushSender } from './Push';
export { Server } from './Server';
export { configFromEnv } from './config';
export { RotatingFileLogger } from './Logging';
export { Telemetry, telemetryFromEnv } from './Telemetry';
export async function main(): Promise<void> {
  const options = resolveOptions(configFromEnv());
  const telemetry = new Telemetry(telemetryFromEnv());
  const files = options.verboseLogs ? await RotatingFileLogger.open({
    directory: options.logDirectory, maxBytes: options.logMaxBytes,
    fileMaxBytes: options.logFileMaxBytes,
    onError: () => console.error('File logging failed; detailed logging disabled. Check disk space and permissions.'),
  }) : null;
  const server = new Server({ ...options,
    pushSender: process.env.FCM_ENABLED === 'true' ? createPushSender() : null,
    telemetry: (event, details) => telemetry.observe(event, details),
    logger: text => { if (files) files.write(text); else console.log(text); },
  });
  // A monitor does not suppress Node's fatal-exception behavior. Delivery after
  // a crash is best effort; process supervisors remain responsible for restarts.
  const fatal = (error: Error): void => {
    try { telemetry.capture('server.fatal', error); void telemetry.flush(true); } catch { /* Do not replace the original fatal exception. */ }
  };
  let stopping: Promise<void> | null = null;
  const removeListeners = (): void => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('uncaughtExceptionMonitor', fatal);
  };
  const shutdown = (): void => {
    stopping ??= (async () => {
      try { await server.stop(); }
      catch (error) { telemetry.capture('server.shutdown_failed', error); console.error('Server shutdown failed'); process.exitCode = 1; }
      finally {
        await telemetry.close();
        await files?.close().catch(() => { console.error('Log flush failed'); process.exitCode = 1; });
        removeListeners();
      }
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.on('uncaughtExceptionMonitor', fatal);
  try { await server.start(); telemetry.start(() => server.stats()); }
  catch (error) {
    telemetry.capture('server.start_failed', error);
    process.exitCode = 1;
    console.error('Server startup failed');
    shutdown();
    await stopping;
  }
}
if (require.main === module) {
  void main().catch(() => { console.error('Server configuration failed'); process.exitCode = 1; });
}
