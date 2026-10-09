export interface ServerOptions {
  host?: string; port?: number; devMode?: boolean; sendDelayMs?: number;
  maxPayloadBytes?: number; maxBufferedBytes?: number; maxConnections?: number;
  maxConnectionsPerIp?: number; maxAccounts?: number; maxRooms?: number;
  maxRoomPlayers?: number; maxMessagesPerSecond?: number; maxConnectionsPerMinute?: number;
  accountTtlMs?: number; heartbeatIntervalMs?: number; idleTimeoutMs?: number;
  authTimeoutMs?: number; maintenanceIntervalMs?: number; shutdownTimeoutMs?: number;
  allowedOrigins?: string[]; allowNoOrigin?: boolean; logger?: (text: string) => void;
}
export type ResolvedOptions = Required<ServerOptions>;
export const defaults: ResolvedOptions = {
  host: '127.0.0.1', port: 8080, devMode: false, sendDelayMs: 0,
  maxPayloadBytes: 65536, maxBufferedBytes: 262144, maxConnections: 256,
  maxConnectionsPerIp: 32, maxAccounts: 1024, maxRooms: 128, maxRoomPlayers: 16,
  maxMessagesPerSecond: 120, maxConnectionsPerMinute: 60, accountTtlMs: 300000,
  heartbeatIntervalMs: 10000, idleTimeoutMs: 50000, authTimeoutMs: 5000,
  maintenanceIntervalMs: 1000, shutdownTimeoutMs: 1000,
  allowedOrigins: ['http://127.0.0.1:8081', 'http://localhost:8081'],
  allowNoOrigin: true, logger: () => undefined,
};
export const numericKeys = [
  'port', 'sendDelayMs', 'maxPayloadBytes', 'maxBufferedBytes', 'maxConnections',
  'maxConnectionsPerIp', 'maxAccounts', 'maxRooms', 'maxRoomPlayers',
  'maxMessagesPerSecond', 'maxConnectionsPerMinute', 'accountTtlMs',
  'heartbeatIntervalMs', 'idleTimeoutMs', 'authTimeoutMs', 'maintenanceIntervalMs',
  'shutdownTimeoutMs',
] as const;
export function resolveOptions(options: ServerOptions = {}): ResolvedOptions {
  const result = { ...defaults, ...options, allowedOrigins: [...(options.allowedOrigins ?? defaults.allowedOrigins)] };
  for (const key of numericKeys) {
    const value = result[key];
    const minimum = key === 'port' || key === 'sendDelayMs' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > (key === 'port' ? 65535 : 2147483647)) {
      throw new TypeError(`Invalid option: ${key}`);
    }
  }
  if (typeof result.host !== 'string' || !result.host.trim() ||
      typeof result.devMode !== 'boolean' || typeof result.allowNoOrigin !== 'boolean' ||
      typeof result.logger !== 'function' || !Array.isArray(result.allowedOrigins) ||
      result.allowedOrigins.some(origin => typeof origin !== 'string' || !/^https?:\/\/[^\s/?#]+$/.test(origin))) {
    throw new TypeError('Invalid server options');
  }
  return result;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): ServerOptions {
  const options: ServerOptions = {};
  if (env.HOST !== undefined) options.host = env.HOST;
  for (const key of numericKeys) {
    const envKey = key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase();
    const value = env[envKey];
    if (value !== undefined) {
      if (!/^\d+$/.test(value)) throw new TypeError(`Invalid setting: ${envKey}`);
      options[key] = Number(value);
    }
  }
  for (const [key, envKey] of [['allowNoOrigin', 'ALLOW_NO_ORIGIN'], ['devMode', 'DEV_MODE']] as const) {
    const value = env[envKey];
    if (value !== undefined) {
      if (value !== 'true' && value !== 'false') throw new TypeError(`Invalid setting: ${envKey}`);
      options[key] = value === 'true';
    }
  }
  if (env.ALLOWED_ORIGINS !== undefined) options.allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  if (argv.includes('dev')) options.devMode = true;
  const delay = argv.find(arg => arg.startsWith('delay='));
  if (delay !== undefined) {
    if (!/^delay=\d+$/.test(delay)) throw new TypeError('Invalid delay');
    options.sendDelayMs = Number(delay.slice(6));
  }
  resolveOptions(options);
  return options;
}
