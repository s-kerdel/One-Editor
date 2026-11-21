// stdio transport: newline-delimited JSON-RPC on stdin / stdout (MCP stdio binding). Messages are
// handled concurrently (answers may come back out of order: JSON-RPC matches them by id). A line
// longer than MAX_LINE is refused without being kept in memory. Logs go to stderr only (stdout-guard.ts).
import type { Readable } from 'node:stream';
import { ERR, type McpProtocol } from './protocol';

export const MAX_LINE = 4 * 1024 * 1024;
/** After stdin ends, answers still being worked on get this long before the process goes. */
export const DRAIN_MS = 15_000;

export interface StdioOptions {
  input: Readable;
  /** Writes one complete line (the message + '\n'). */
  write(line: string): void;
  onClose(): void;
}

export class StdioTransport {
  private buf = '';
  private skipping = false;
  private closed = false;
  private ending = false;
  private pending = 0;
  private drained: (() => void) | null = null;

  constructor(
    private readonly protocol: McpProtocol,
    private readonly o: StdioOptions,
  ) {
    protocol.attach((m) => this.send(m)); // our own requests to the client (elicitation)
    o.input.setEncoding('utf8');
    o.input.on('data', (chunk: string) => this.data(chunk));
    // End of input (the client is done): finish what is in flight, then close. A broken pipe closes at once.
    o.input.on('end', () => void this.drainThenClose());
    o.input.on('close', () => void this.drainThenClose());
    o.input.on('error', () => this.close());
  }

  private data(chunk: string) {
    let start = 0;
    for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
      const piece = chunk.slice(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        this.buf = '';
        continue;
      }
      const line = this.buf + piece;
      this.buf = '';
      this.line(line);
    }
    if (this.skipping) return;
    this.buf += chunk.slice(start);
    if (this.buf.length > MAX_LINE) {
      // Too big to be one of ours: drop it up to its newline and say so (no id is known yet).
      this.buf = '';
      this.skipping = true;
      this.send({ jsonrpc: '2.0', id: null, error: { code: ERR.invalidRequest, message: `Message too large (over ${MAX_LINE / 1048576} MB)` } });
    }
  }

  private line(raw: string) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!text.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'Parse error' } });
      return;
    }
    this.pending++;
    void this.protocol
      .handle(msg)
      .then(
        (res) => res !== null && this.send(res),
        () => {},
      )
      .finally(() => {
        if (--this.pending === 0) this.drained?.();
      });
  }

  /** Server → client notification (e.g. notifications/tools/list_changed). */
  notify(method: string, params: Record<string, unknown> = {}) {
    if (this.protocol.canNotify) this.send({ jsonrpc: '2.0', method, params });
  }

  private send(m: unknown) {
    if (this.closed) return;
    // JSON.stringify never emits a raw newline, so one message is exactly one line.
    this.o.write(`${JSON.stringify(m)}\n`);
  }

  private async drainThenClose() {
    if (this.ending || this.closed) return;
    this.ending = true;
    if (this.buf.trim() && !this.skipping) this.line(this.buf); // a last message without its newline
    this.buf = '';
    this.protocol.endOfInput(); // questions to the user can no longer be answered
    if (this.pending) {
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((r) => {
        this.drained = r;
        timer = setTimeout(r, DRAIN_MS);
        timer.unref?.();
      });
      clearTimeout(timer);
    }
    this.close();
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.o.onClose();
  }
}
