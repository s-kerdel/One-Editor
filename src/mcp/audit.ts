// Activity log of the MCP server: one JSON line per tool call in <app data>/mcp-audit.jsonl, shown in
// Settings → MCP server. Never content, never a search query: time, client, tool, folder, path, result
// code, duration and answer size. Several server processes may append at once (short appends are atomic);
// the file rotates at MAX_BYTES (one .1 generation kept), checked every few writes, under the app's file lock.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../backend/filelock';
import type { McpActivity } from '../shared/mcp';

export const AUDIT_MAX_BYTES = 1024 * 1024;
const CHECK_EVERY = 50;

export class AuditLog {
  private writes = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  record(row: Omit<McpActivity, 't' | 'reverted'> & { t?: number }) {
    const line = `${JSON.stringify({ t: row.t ?? Date.now(), client: row.client, transport: row.transport, tool: row.tool, folder: row.folder, path: row.path, ok: row.ok, code: row.code, ms: row.ms, bytes: row.bytes, ...(row.journal ? { journal: row.journal } : {}), ...(row.token ? { token: row.token } : {}) })}\n`;
    const check = this.writes++ % CHECK_EVERY === 0;
    // Serialised per process; the activity log is best effort (a full disk must not fail a tool call).
    this.chain = this.chain
      .then(async () => {
        if (check) await this.rotate();
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.appendFile(this.file, line, { mode: 0o600 });
      })
      .catch(() => {});
    return this.chain;
  }

  private async rotate() {
    const st = await fsp.stat(this.file).catch(() => null);
    if (!st || st.size < AUDIT_MAX_BYTES) return;
    await withFileLock(this.file, async () => {
      const again = await fsp.stat(this.file).catch(() => null);
      if (again && again.size >= AUDIT_MAX_BYTES) await fsp.rename(this.file, `${this.file}.1`).catch(() => {});
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/** The newest `limit` lines (newest first), reading only the end of the file. */
export function tailLines(file: string, maxBytes = 128 * 1024): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // cut mid-line
    return lines.filter(Boolean).reverse();
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
