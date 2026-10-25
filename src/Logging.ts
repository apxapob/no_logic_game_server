import { mkdir, readdir, stat, open, unlink, FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const secretKey = /password|passwd|secret|token|authorization|cookie|api[-_]?key/i;
/** Never mutate the actual message while preparing its diagnostic copy. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[depth limit]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, secretKey.test(key) ? '[REDACTED]' : redact(item, depth + 1)]));
  }
  return value;
}

interface LogFile { path: string; size: number }
interface LogOptions {
  directory: string; maxBytes: number; fileMaxBytes: number;
  onError?: () => void;
}
const filePattern = /^server-(\d{20})\.jsonl$/;
const queueLimit = 8 * 1024 ** 2;

/** One writer per directory. Rotation counts the active file and all previous runs. */
export class RotatingFileLogger {
  private readonly files: LogFile[] = [];
  private total = 0;
  private sequence = 0n;
  private handle: FileHandle | null = null;
  private current: LogFile | null = null;
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private processing: Promise<void> | null = null;
  private accepting = true;
  private failure: unknown;
  private constructor(private readonly options: LogOptions) {}

  static async open(options: LogOptions): Promise<RotatingFileLogger> {
    for (const size of [options.maxBytes, options.fileMaxBytes]) {
      if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('Invalid log size');
    }
    const logger = new RotatingFileLogger({ ...options, directory: resolve(options.directory) });
    await mkdir(logger.options.directory, { recursive: true, mode: 0o700 });
    const entries = (await readdir(logger.options.directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && filePattern.test(entry.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(logger.options.directory, entry.name);
      const size = (await stat(path)).size;
      logger.files.push({ path, size }); logger.total += size;
      logger.sequence = BigInt(filePattern.exec(entry.name)![1]);
    }
    await logger.makeRoom(0);
    return logger;
  }

  write(line: string): void {
    if (!this.accepting || this.failure) return;
    let bytes = Buffer.from(line + '\n');
    if (bytes.length > this.options.maxBytes || bytes.length > queueLimit) {
      bytes = Buffer.from(JSON.stringify({ time: new Date().toISOString(), event: 'log.record_too_large', bytes: bytes.length }) + '\n');
    }
    if (bytes.length > this.options.maxBytes || this.queuedBytes + bytes.length > queueLimit) {
      this.dropped++; return;
    }
    this.queue.push(bytes); this.queuedBytes += bytes.length;
    this.startDrain();
  }

  private startDrain(): void {
    if (!this.processing) {
      this.processing = this.drain().catch(async error => {
        this.failure = error; this.queue.length = 0; this.queuedBytes = 0;
        await this.closeFile().catch(() => undefined);
        try { this.options.onError?.(); } catch { /* Diagnostics cannot stop the game. */ }
      }).finally(() => {
        this.processing = null;
        // A producer may enqueue between drain() resolving and this continuation.
        if (!this.failure && this.queue.length) this.startDrain();
      });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length || this.dropped) {
      if (this.dropped && this.queue.length === 0) {
        const bytes = Buffer.from(JSON.stringify({ time: new Date().toISOString(), event: 'log.records_dropped', count: this.dropped }) + '\n');
        this.dropped = 0;
        if (bytes.length <= this.options.maxBytes) { this.queue.push(bytes); this.queuedBytes += bytes.length; }
      }
      const first = this.queue.shift();
      if (!first) continue;
      const batch = [first];
      let size = first.length;
      const batchLimit = Math.min(256 * 1024, this.options.fileMaxBytes, this.options.maxBytes);
      while (this.queue.length && size + this.queue[0].length <= batchLimit) {
        const next = this.queue.shift()!; batch.push(next); size += next.length;
      }
      this.queuedBytes -= size;
      const limit = Math.min(this.options.fileMaxBytes, this.options.maxBytes);
      if (this.current && this.current.size + size > limit) await this.closeFile();
      await this.makeRoom(size);
      if (!this.handle) {
        const path = join(this.options.directory, `server-${(++this.sequence).toString().padStart(20, '0')}.jsonl`);
        this.handle = await open(path, 'wx', 0o600);
        this.current = { path, size: 0 }; this.files.push(this.current);
      }
      await this.handle.writeFile(Buffer.concat(batch, size));
      this.current!.size += size; this.total += size;
    }
  }

  private async closeFile(): Promise<void> {
    const handle = this.handle;
    this.handle = null; this.current = null;
    await handle?.close();
  }

  private async makeRoom(incoming: number): Promise<void> {
    while (this.total + incoming > this.options.maxBytes && this.files.length) {
      const oldest = this.files[0];
      if (oldest === this.current) await this.closeFile();
      await unlink(oldest.path);
      this.total -= oldest.size; this.files.shift();
    }
  }

  async flush(): Promise<void> {
    while (this.processing) await this.processing;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    this.accepting = false;
    try { await this.flush(); } finally { await this.closeFile(); }
  }
}
