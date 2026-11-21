// stdio transport framing (split chunks, CRLF, blank lines, bad JSON, oversized lines) and stdout
// hygiene: with stdout-guard loaded first, console.* and stray stdout writes all land on stderr.
import { afterAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { ERR, McpProtocol } from '../../../src/mcp/protocol';
import { MAX_LINE, StdioTransport } from '../../../src/mcp/stdio';

const root = path.resolve(__dirname, '../../..');
const tmp = path.join(root, '.tmp/mcp/unit', `stdio-${crypto.randomBytes(4).toString('hex')}`);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function rig() {
  const input = new PassThrough();
  const out: any[] = [];
  let closed = 0;
  const p = new McpProtocol({ info: { name: 'one', version: '1' }, instructions: '', tools: () => [] });
  const t = new StdioTransport(p, { input, write: (l) => out.push(JSON.parse(l)), onClose: () => closed++ });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  return { input, out, t, tick, closed: () => closed };
}

describe('StdioTransport', () => {
  it('frames messages split across chunks, with CRLF and blank lines', async () => {
    const r = rig();
    r.input.write('{"jsonrpc":"2.0","id":1,"me');
    r.input.write('thod":"ping"}\r\n\n  \n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    await r.tick();
    expect(r.out.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  it('answers bad JSON with a parse error and keeps going', async () => {
    const r = rig();
    r.input.write('{nope}\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await r.tick();
    expect(r.out[0]).toMatchObject({ id: null, error: { code: ERR.parse } });
    expect(r.out[1]).toMatchObject({ id: 3, result: {} });
  });

  it('drops an oversized line without keeping it, then serves the next one', async () => {
    const r = rig();
    const chunk = 'x'.repeat(1 << 20);
    for (let i = 0; i <= MAX_LINE / chunk.length; i++) r.input.write(chunk);
    r.input.write('\n{"jsonrpc":"2.0","id":4,"method":"ping"}\n');
    await r.tick();
    expect(r.out[0]).toMatchObject({ id: null, error: { code: ERR.invalidRequest } });
    expect(r.out[1]).toMatchObject({ id: 4 });
  });

  it('notifications to the client go out only after a legacy client initialized; end of input closes', async () => {
    const r = rig();
    r.t.notify('notifications/tools/list_changed');
    r.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await r.tick();
    r.t.notify('notifications/tools/list_changed');
    expect(r.out.map((m) => m.method ?? m.id)).toEqual([1, 'notifications/tools/list_changed']);
    r.input.end();
    await r.tick();
    expect(r.closed()).toBe(1);
  });
});

describe('end of input', () => {
  it('answers what is still in flight (and a last line without newline) before closing', async () => {
    const input = new PassThrough();
    const out: any[] = [];
    let closedAt = -1;
    const slow = { name: 'slow', title: 's', description: 'slow', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, run: () => new Promise<any>((r) => setTimeout(() => r({ content: [{ type: 'text', text: 'done' }] }), 80)) };
    const p = new McpProtocol({ info: { name: 'one', version: '1' }, instructions: '', tools: () => [slow] });
    new StdioTransport(p, { input, write: (l) => out.push(JSON.parse(l)), onClose: () => (closedAt = out.length) });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"slow"}}');
    input.end();
    await new Promise((r) => setTimeout(r, 200));
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[1].result.content[0].text).toBe('done');
    expect(closedAt).toBe(2);
  });
});

describe('stdout hygiene', () => {
  it('stdout-guard sends console output and stray writes to stderr; only writeProtocol reaches stdout', async () => {
    fs.mkdirSync(tmp, { recursive: true });
    const out = path.join(tmp, 'guard.mjs');
    await build({
      stdin: {
        contents: [
          "import { writeProtocol } from './src/mcp/stdout-guard';",
          "console.log('log noise'); console.info('info noise'); console.warn('warn noise'); console.debug('debug noise');",
          "process.stdout.write('raw noise\\n');",
          'writeProtocol(\'{"jsonrpc":"2.0","id":1,"result":{}}\\n\');',
        ].join('\n'),
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: out,
      logLevel: 'silent',
    });
    const res = execFileSync(process.execPath, [out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(res).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    const err = spawnSync(process.execPath, [out], { encoding: 'utf8' }).stderr;
    for (const s of ['log noise', 'info noise', 'warn noise', 'debug noise', 'raw noise']) expect(err).toContain(s);
  });
});
