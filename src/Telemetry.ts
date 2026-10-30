import { randomUUID } from 'node:crypto';
import { request } from 'node:https';

type Properties = Record<string, string | number | boolean | null>;
interface TelemetryEvent {
  id: string; timestamp: string; type: 'event' | 'error'; name: string;
  sessionId: string; release: string; platform: string; properties?: Properties;
  error?: { name: string; message: string; stack?: string };
}
export interface TelemetryOptions {
  url: string | null; writeKey: string; project: string; release: string;
  intervalMs: number; timeoutMs: number;
}
type Transport = (url: string, key: string, body: string, signal: AbortSignal) => Promise<number>;
interface Dependencies { transport?: Transport; now?: () => number }
const queueLimit = 256;
const byteLimit = 512 * 1024;
const bodyLimit = 64 * 1024;
const counts = {
  'connection.connected': 'connections', 'connection.disconnected': 'disconnects',
  'connection.error': 'socketErrors', 'transport.rejected': 'transportRejected',
  'transport.error': 'transportErrors', 'transport.timeout': 'transportTimeouts',
  'upgrade.rejected': 'upgradeRejected', 'upgrade.error': 'upgradeErrors',
  'authentication.failed': 'authFailures', 'authentication.succeeded': 'authSuccesses',
  'protocol.error': 'protocolErrors', 'room.created': 'roomsCreated',
  'room.deleted': 'roomsDeleted', 'room.entered': 'roomEntries', 'room.left': 'roomLeaves',
  'room.owner_changed': 'ownerChanges', 'room.game_started': 'gamesStarted',
  'message.discarded': 'messagesDiscarded', 'message.not_sent': 'messagesNotSent',
  'account.expired': 'accountsExpired',
} as const;
const errorEvents: Record<string, string> = {
  'http server error': 'server.http_error', 'websocket server error': 'server.websocket_error',
  'server.start_failed': 'server.start_failed',
};

export function telemetryFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryOptions {
  const enabled = env.TELEMETRY_ENABLED;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new TypeError('Invalid setting: TELEMETRY_ENABLED');
  // The explicit kill switch must work even with stale or malformed credentials.
  // Discard every unused setting so disabled telemetry cannot prevent startup.
  if (enabled === 'false') return { url: null, writeKey: '', project: 'no-logic', release: '1.0.0', intervalMs: 60000, timeoutMs: 5000 };
  const url = env.TELEMETRY_URL?.trim() || null;
  const writeKey = env.TELEMETRY_WRITE_KEY?.trim() ?? '';
  if (enabled === 'true' && (!url || !writeKey)) throw new TypeError('Enabled telemetry requires TELEMETRY_URL and TELEMETRY_WRITE_KEY');
  const project = env.TELEMETRY_PROJECT ?? 'no-logic';
  const release = env.TELEMETRY_RELEASE ?? '1.0.0';
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const text = env[key];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid setting: ${key}`);
    return value;
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)) throw new TypeError('Invalid setting: TELEMETRY_PROJECT');
  if (!/^[a-zA-Z0-9._+-]{1,64}$/.test(release)) throw new TypeError('Invalid setting: TELEMETRY_RELEASE');
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new TypeError('Invalid setting: TELEMETRY_URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('Invalid setting: TELEMETRY_URL');
  }
  if (writeKey && (!/^[a-zA-Z0-9_-]{24,128}$/.test(writeKey))) throw new TypeError('Invalid setting: TELEMETRY_WRITE_KEY');
  return { url: url && writeKey ? url : null, writeKey, project, release,
    intervalMs: number('TELEMETRY_INTERVAL_MS', 60000, 1000, 3600000),
    timeoutMs: number('TELEMETRY_TIMEOUT_MS', 5000, 100, 30000) };
}

/** No response body is retained; redirects never forward the write key. */
const send: Transport = (url, key, body, signal) => new Promise((resolve, reject) => {
  const outgoing = request(url, { method: 'POST', signal, headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${key}`,
  } }, response => {
    const status = response.statusCode ?? 0;
    response.destroy(); resolve(status);
  });
  outgoing.on('error', reject);
  outgoing.end(body);
});

function errorName(error: unknown): string {
  // Arbitrary exception messages may embed payloads and credentials. Send only a
  // known error class; call-site name and bounded frame locations identify the bug.
  if (!(error instanceof Error)) return 'Error';
  const allowed = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
  return allowed.has(error.name) ? error.name : 'Error';
}
function errorFrames(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
  // Function names and file basenames/line positions only, never URLs or paths.
  const frames = error.stack.split('\n').slice(1, 13).flatMap(line => {
    const match = /(?:^|[/\\])([a-zA-Z0-9_.-]+\.(?:[cm]?js|ts)):(\d+):(\d+)\)?$/.exec(line.trim());
    return match ? [`at ${match[1]}:${match[2]}:${match[3]}`] : [];
  });
  return frames.length ? frames.join('\n').slice(0, 2000) : undefined;
}

/** Loss-tolerant, memory-only telemetry. The game relay never awaits observe(). */
export class Telemetry {
  readonly enabled: boolean;
  private readonly sessionId = randomUUID();
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly queue: { event: TelemetryEvent; bytes: number }[] = [];
  private queuedBytes = 0;
  private readonly activity: Record<string, number> = {};
  private readonly recentErrors = new Map<string, number>();
  private dropped = 0;
  private startedAt: number;
  private windowAt: number;
  private failures = 0;
  private nextAttemptAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private sending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  constructor(private readonly options: TelemetryOptions, dependencies: Dependencies = {}) {
    this.enabled = options.url !== null && options.writeKey.length > 0;
    this.transport = dependencies.transport ?? send;
    this.now = dependencies.now ?? Date.now;
    this.startedAt = this.windowAt = this.now();
  }
  start(stats: () => { accounts: number; online: number; rooms: number; pendingConnections: number }): void {
    if (!this.enabled || this.closed || this.timer) return;
    this.enqueue('server.started');
    const sample = (): void => {
      try { this.sample(stats()); void this.flush(); } catch { /* Telemetry cannot interrupt the relay. */ }
    };
    this.timer = setInterval(sample, this.options.intervalMs);
    this.timer.unref();
    sample();
  }
  observe(event: string, details: Readonly<Record<string, unknown>> = {}): void {
    if (!this.enabled || this.closed) return;
    const count = counts[event as keyof typeof counts];
    if (count) this.activity[count] = Math.min(Number.MAX_SAFE_INTEGER, (this.activity[count] ?? 0) + 1);
    if (event === 'connection.terminate') {
      this.activity.terminated = Math.min(Number.MAX_SAFE_INTEGER, (this.activity.terminated ?? 0) + 1);
      // Read only known internal values. A peer-provided close reason is never used.
      if (details.reason === 'message_rate_limit' || details.reason === 'output_buffer_limit') {
        this.activity.rateLimits = Math.min(Number.MAX_SAFE_INTEGER, (this.activity.rateLimits ?? 0) + 1);
      }
    }
    const name = errorEvents[event];
    if (name) this.capture(name);
  }
  sample(stats: { accounts: number; online: number; rooms: number; pendingConnections: number }): void {
    if (!this.enabled || this.closed) return;
    const now = this.now();
    if (Object.keys(this.activity).length) this.enqueue('server.activity', { ...this.activity, windowMs: Math.max(0, now - this.windowAt) });
    for (const key of Object.keys(this.activity)) delete this.activity[key];
    this.windowAt = now;
    const memory = process.memoryUsage();
    this.enqueue('server.metrics', {
      accounts: stats.accounts, online: stats.online, rooms: stats.rooms, pendingConnections: stats.pendingConnections,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
      telemetryDropped: this.dropped,
    });
  }
  capture(name: string, error?: unknown): void {
    if (!/^server\.(?:http_error|websocket_error|start_failed|fatal|shutdown_failed)$/.test(name) || !this.enabled || this.closed) return;
    const now = this.now();
    const previous = this.recentErrors.get(name);
    if (previous !== undefined && now - previous < 60000) return;
    this.recentErrors.set(name, now);
    const kind = errorName(error);
    this.enqueue(name, undefined, { name: kind, message: name, stack: errorFrames(error) });
  }
  private enqueue(name: string, properties?: Properties, error?: TelemetryEvent['error']): void {
    if (!this.enabled || this.closed) return;
    const event: TelemetryEvent = { id: randomUUID(), timestamp: new Date(this.now()).toISOString(),
      type: error ? 'error' : 'event', name, sessionId: this.sessionId, release: this.options.release,
      platform: `node-${process.platform}`, ...(properties ? { properties } : {}), ...(error ? { error } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > bodyLimit / 2) { this.dropped++; return; }
    while (this.queue.length >= queueLimit || this.queuedBytes + bytes > byteLimit) this.dropOldest();
    this.queue.push({ event, bytes }); this.queuedBytes += bytes;
  }
  private dropOldest(): void {
    const oldest = this.queue.shift();
    if (oldest) { this.queuedBytes -= oldest.bytes; this.dropped++; }
  }
  status(): { queued: number; queuedBytes: number; dropped: number; failures: number } {
    return { queued: this.queue.length, queuedBytes: this.queuedBytes, dropped: this.dropped, failures: this.failures };
  }
  flush(force = false): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.enabled || this.closed || !this.queue.length || (!force && this.now() < this.nextAttemptAt)) return Promise.resolve();
    this.sending = this.sendBatch().finally(() => { this.sending = null; });
    return this.sending;
  }
  private async sendBatch(): Promise<void> {
    const batch: typeof this.queue = [];
    let size = Buffer.byteLength(JSON.stringify({ project: this.options.project, events: [] }));
    while (batch.length < 32 && this.queue.length && size + this.queue[0].bytes + 1 <= bodyLimit) {
      const next = this.queue.shift()!; this.queuedBytes -= next.bytes; batch.push(next); size += next.bytes + 1;
    }
    if (!batch.length) return;
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const status = await this.transport(this.options.url!, this.options.writeKey,
        JSON.stringify({ project: this.options.project, events: batch.map(item => item.event) }), controller.signal);
      if (status >= 200 && status < 300) { this.failures = 0; this.nextAttemptAt = 0; return; }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.dropped += batch.length; this.failures = 0; this.nextAttemptAt = this.now() + 60000; return;
      }
      throw new Error('Telemetry unavailable');
    } catch {
      this.failures = Math.min(this.failures + 1, 10);
      this.nextAttemptAt = this.now() + Math.min(300000, 1000 * 2 ** (this.failures - 1));
      if (!this.closed) {
        this.queue.unshift(...batch); this.queuedBytes += batch.reduce((sum, item) => sum + item.bytes, 0);
        while (this.queue.length > queueLimit || this.queuedBytes > byteLimit) this.dropOldest();
      }
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
  async close(deadlineMs = 1000): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.enqueue('server.stopped', { telemetryDropped: this.dropped });
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => { timeout = setTimeout(resolve, deadlineMs); });
    await Promise.race([(async () => {
      await this.flush(true);
      // A bounded final drain. Errors stop the loop; offline data is deliberately discarded.
      for (let attempt = 0; this.queue.length && !this.failures && attempt < 8; attempt++) await this.flush(true);
    })(), deadline]);
    if (timeout) clearTimeout(timeout);
    this.closed = true;
    this.controller?.abort();
    this.queue.length = 0; this.queuedBytes = 0;
  }
}
