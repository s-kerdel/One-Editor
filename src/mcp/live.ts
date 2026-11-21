// The running server's live file (<app data>/mcp-live/<pid>-<random>.json): One's desktop app shows "MCP active"
// from it (main/mcp.ts reads the folder). It holds the process id, the app it serves (the access token's
// name), when it started and when it last answered a call; never a path, text, a query or a token.
// Written atomically (temp + rename), at most once per THROTTLE_MS (a trailing write keeps the last call),
// removed on exit. App data read-only or missing: every step is skipped silently (the server still serves).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { McpLiveFile } from '../shared/mcp';

export const LIVE_THROTTLE_MS = 5_000;

export class LiveFile {
  readonly file: string;
  private readonly data: McpLiveFile;
  private lastWrite = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    dir: string,
    o: { pid?: number; client: string },
    private readonly now: () => number = Date.now,
    private readonly throttleMs = LIVE_THROTTLE_MS,
  ) {
    const pid = o.pid ?? process.pid;
    this.file = path.join(dir, `${pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    this.data = { v: 1, pid, client: o.client.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60), started: now(), lastCall: null };
  }

  /** At startup (after the token check). */
  start(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    } catch {}
    this.write();
  }

  /** A call was answered: written now, or once the throttle allows (the latest time either way). */
  touch(): void {
    if (this.stopped) return;
    this.data.lastCall = this.now();
    const wait = this.lastWrite + this.throttleMs - this.now();
    if (wait <= 0) return this.write();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, wait);
    this.timer.unref?.();
  }

  /** On exit (also from an exit handler: synchronous). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      fs.rmSync(this.file, { force: true });
    } catch {}
  }

  private write(): void {
    if (this.stopped) return;
    this.lastWrite = this.now();
    const tmp = `${this.file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
  }
}
