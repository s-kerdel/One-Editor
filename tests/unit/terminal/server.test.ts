// Browser mode never exposes a shell: every terminal-ish RPC name is refused with ENOTSUP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../../../src/server/server';
import { TERMINAL_RPC_METHODS } from '../../../src/shared/terminal';

const TMP = fileURLToPath(new URL('../../../.tmp/terminal/unit', import.meta.url));
let tmp: string;
let srv: RunningServer;

function rpc(method: string, args: unknown[] = []) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: `/api/rpc/${method}`, method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': srv.token } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    r.on('error', reject);
    r.end(JSON.stringify({ args }));
  });
}

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(TMP, 'srv-'));
  await fsp.mkdir(path.join(tmp, 'ws'));
  await fsp.mkdir(path.join(tmp, 'renderer'));
  await fsp.writeFile(path.join(tmp, 'renderer', 'index.html'), '<!doctype html><title>t</title>');
  srv = await startServer({ root: path.join(tmp, 'ws'), port: 0, rendererDir: path.join(tmp, 'renderer'), configDir: path.join(tmp, 'cfg') });
});
afterAll(async () => {
  await srv.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('HTTP server: no terminal', () => {
  it('refuses every terminal RPC with ENOTSUP', async () => {
    for (const m of [...TERMINAL_RPC_METHODS, 'terminal', 'termSpawn', 'terminalAnything']) {
      const r = await rpc(m, [{ shellId: 'bash' }]);
      expect(r.body, m).toMatchObject({ ok: false, error: { code: 'ENOTSUP' } });
    }
  });

  it('still serves normal RPC', async () => {
    expect((await rpc('getWorkspace')).body).toMatchObject({ ok: true, result: { name: 'ws' } });
  });
});
