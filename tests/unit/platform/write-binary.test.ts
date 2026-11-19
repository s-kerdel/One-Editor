// writeBinary end to end: workspace (bytes), service (base64 validation + cap), HTTP transport (body cap).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Workspace } from '../../../src/backend/workspace';
import { BackendService } from '../../../src/backend/service';
import { startServer } from '../../../src/server/server';
import { MAX_BINARY_BYTES } from '../../../src/shared/api';
import { tmpRoot } from './helpers';

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
// Every byte value, in every position mod 3 (so all base64 alignments are exercised).
const PATTERN = Buffer.concat([ALL_BYTES, ALL_BYTES.subarray(1), ALL_BYTES.subarray(2), Buffer.from(ALL_BYTES).reverse()]);

let dir: string;
let ws: Workspace;
beforeEach(async () => {
  dir = await tmpRoot('wb');
  await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'notes', 'a.md'), '# A\n');
  ws = new Workspace(dir, { debounceMs: 10 });
  await ws.listTree();
});
afterEach(async () => {
  ws.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e?.code);

describe('Workspace.writeBinary', () => {
  it('round-trips all 256 byte values exactly, creating parent folders', async () => {
    const r = await ws.writeBinary('attachments/deep/Pasted image.png', PATTERN);
    const disk = await fsp.readFile(path.join(dir, 'attachments/deep/Pasted image.png'));
    expect(Buffer.compare(disk, PATTERN)).toBe(0);
    expect(r.mtime).toBe((await fsp.stat(path.join(dir, 'attachments/deep/Pasted image.png'))).mtimeMs);
    // Tree index knows the file and its new parents (like writeFile).
    expect(ws.filePaths()).toContain('attachments/deep/Pasted image.png');
    // No temp files left behind.
    expect(await fsp.readdir(path.join(dir, 'attachments/deep'))).toEqual(['Pasted image.png']);
  });

  it('overwrites an existing file and keeps its mode', async () => {
    const f = path.join(dir, 'img.bin');
    await fsp.writeFile(f, 'old text content');
    if (process.platform !== 'win32') await fsp.chmod(f, 0o640);
    await ws.writeBinary('img.bin', ALL_BYTES);
    expect(Buffer.compare(await fsp.readFile(f), ALL_BYTES)).toBe(0);
    if (process.platform !== 'win32') expect((await fsp.stat(f)).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlink without replacing it', async () => {
    await fsp.writeFile(path.join(dir, 'target.bin'), 'x');
    try {
      await fsp.symlink(path.join(dir, 'target.bin'), path.join(dir, 'link.bin'));
    } catch {
      return; // no symlink permission (Windows without dev mode)
    }
    await ws.writeBinary('link.bin', ALL_BYTES);
    expect((await fsp.lstat(path.join(dir, 'link.bin'))).isSymbolicLink()).toBe(true);
    expect(Buffer.compare(await fsp.readFile(path.join(dir, 'target.bin')), ALL_BYTES)).toBe(0);
  });

  it('stays inside the workspace; refuses the root, folders and read-only files', async () => {
    // Relative paths are normalised against the root ('..' clamps there), so traversal can't escape.
    const outside = path.join(dir, '..', `${path.basename(dir)}-escape.png`);
    for (const p of [`../${path.basename(dir)}-escape.png`, `notes/../../../${path.basename(dir)}-escape.png`, `/${path.basename(dir)}-escape.png`, `..\\${path.basename(dir)}-escape.png`]) {
      expect(await code(ws.writeBinary(p, ALL_BYTES)), p).toBe('ok');
      expect(fs.existsSync(outside), p).toBe(false);
    }
    expect(Buffer.compare(await fsp.readFile(path.join(dir, `${path.basename(dir)}-escape.png`)), ALL_BYTES)).toBe(0);
    expect(() => ws.abs('../../x')).not.toThrow();
    expect(ws.rel(ws.abs('../../x'))).toBe('x');
    expect(await code(ws.writeBinary('', ALL_BYTES))).toBe('EINVAL');
    expect(await code(ws.writeBinary('notes', ALL_BYTES))).toBe('EISDIR');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await fsp.writeFile(path.join(dir, 'ro.png'), 'x');
      await fsp.chmod(path.join(dir, 'ro.png'), 0o444);
      expect(await code(ws.writeBinary('ro.png', ALL_BYTES))).toBe('EACCES');
      expect(await fsp.readFile(path.join(dir, 'ro.png'), 'utf8')).toBe('x');
    }
  });

  it('refuses more than MAX_BINARY_BYTES', async () => {
    expect(await code(ws.writeBinary('big.bin', new Uint8Array(MAX_BINARY_BYTES + 1)))).toBe('ETOOBIG');
    expect(fs.existsSync(path.join(dir, 'big.bin'))).toBe(false);
  });

  it('is serialised with writeFile on the same path (call order wins, never interleaved)', async () => {
    const big = Buffer.alloc(24 * 1024 * 1024, 0xab);
    // Binary first (slow), text right after: without the per-path queue the text would land first
    // and then be clobbered by the bigger binary write.
    const a = ws.writeBinary('race.dat', big);
    const b = ws.writeFile('race.dat', 'text wins');
    await Promise.all([a, b]);
    expect(await fsp.readFile(path.join(dir, 'race.dat'), 'utf8')).toBe('text wins');
    // …and the other way round.
    const c = ws.writeFile('race.dat', 'x'.repeat(8 * 1024 * 1024));
    const d = ws.writeBinary('race.dat', ALL_BYTES);
    await Promise.all([c, d]);
    expect(Buffer.compare(await fsp.readFile(path.join(dir, 'race.dat')), ALL_BYTES)).toBe(0);
    expect((await fsp.readdir(dir)).filter((n) => n.includes('sec-edit'))).toEqual([]);
  });

  it('is serialised with a rename of its folder', async () => {
    const w = ws.writeBinary('notes/img.png', Buffer.alloc(8 * 1024 * 1024, 1));
    const r = ws.rename('notes', 'moved');
    await Promise.all([w, r]);
    expect(fs.existsSync(path.join(dir, 'moved/img.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes'))).toBe(false);
  });

  it('does not echo its own write back as an external change', async () => {
    const events: unknown[] = [];
    const off = ws.onEvents((e) => events.push(...e));
    await new Promise((r) => setTimeout(r, 100)); // watcher up
    await ws.writeBinary('attachments/shot.png', PATTERN);
    await ws.writeBinary('attachments/shot.png', ALL_BYTES); // overwrite too
    await new Promise((r) => setTimeout(r, 300));
    await ws.settle();
    off();
    expect(events.filter((e: any) => e.path.startsWith('attachments'))).toEqual([]);
  });
});

describe('Workspace.writeBinary on Windows rules', () => {
  it('refuses reserved device names, ADS and trailing dots', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      vi.resetModules();
      const { Workspace: WinWorkspace } = await import('../../../src/backend/workspace');
      const w = new WinWorkspace(dir);
      for (const bad of ['aux.png', 'attachments/NUL.png', 'com1', 'a.png:hidden', 'shot.png.', 'x/LPT9.jpg']) {
        expect(await code(w.writeBinary(bad, ALL_BYTES)), bad).toBe('EINVAL');
      }
      w.dispose();
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
      vi.resetModules();
    }
    expect(fs.existsSync(path.join(dir, 'aux.png'))).toBe(false);
  });
});

describe('BackendService.writeBinary (base64)', () => {
  let svc: BackendService;
  beforeEach(async () => {
    svc = new BackendService(path.join(dir, '..', path.basename(dir) + '-cfg'));
    await svc.openWorkspace(dir);
  });
  afterEach(() => svc.dispose());

  it('decodes standard base64, with and without padding', async () => {
    for (const [i, bytes] of [ALL_BYTES, PATTERN, ALL_BYTES.subarray(0, 1), ALL_BYTES.subarray(0, 2), Buffer.alloc(0)].entries()) {
      await svc.writeBinary(`b/${i}.bin`, bytes.toString('base64'));
      expect(Buffer.compare(await fsp.readFile(path.join(dir, `b/${i}.bin`)), bytes)).toBe(0);
      await svc.writeBinary(`b/${i}-np.bin`, bytes.toString('base64').replace(/=+$/, ''));
      expect(Buffer.compare(await fsp.readFile(path.join(dir, `b/${i}-np.bin`)), bytes)).toBe(0);
    }
  });

  it('rejects malformed payloads instead of writing garbage', async () => {
    for (const bad of ['not base64!', 'QUJD\nREVG', 'A', 'QUJD====', '-_-_']) {
      expect(await code(Promise.resolve().then(() => svc.writeBinary('bad.bin', bad))), bad).toBe('EINVAL');
    }
    expect(await code(Promise.resolve().then(() => svc.writeBinary('bad.bin', 42 as any)))).toBe('EINVAL');
    expect(fs.existsSync(path.join(dir, 'bad.bin'))).toBe(false);
  });

  it('caps the decoded size before decoding', async () => {
    const tooBig = 'A'.repeat(Math.ceil((MAX_BINARY_BYTES + 3) / 3) * 4);
    const err = await Promise.resolve()
      .then(() => svc.writeBinary('big.bin', tooBig))
      .catch((e) => e);
    expect(err.code).toBe('ETOOBIG');
    expect(err.message).toMatch(/limit is 50 MB/);
  });

  it('requires an open workspace', async () => {
    const empty = new BackendService(path.join(dir, '..', path.basename(dir) + '-cfg2'));
    expect(await code(Promise.resolve().then(() => empty.writeBinary('x.png', 'AAAA')))).toBe('NO_WORKSPACE');
  });
});

describe('HTTP transport', () => {
  function post(port: number, token: string, method: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: `/api/rpc/${method}`, method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': token, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      r.on('error', reject);
      r.end(body);
    });
  }

  it('writes bytes over RPC and answers oversized bodies with a clear JSON error', async () => {
    const renderer = path.join(dir, '..', path.basename(dir) + '-r');
    await fsp.mkdir(renderer, { recursive: true });
    await fsp.writeFile(path.join(renderer, 'index.html'), '<html><head></head></html>');
    const srv = await startServer({ root: dir, port: 0, rendererDir: renderer, configDir: path.join(renderer, 'cfg') });
    try {
      const ok = await post(srv.port, srv.token, 'writeBinary', JSON.stringify({ args: ['att/x.png', PATTERN.toString('base64')] }));
      expect(ok.json).toMatchObject({ ok: true, result: { mtime: expect.any(Number) } });
      expect(Buffer.compare(await fsp.readFile(path.join(dir, 'att/x.png')), PATTERN)).toBe(0);

      // A body over the writeBinary cap (declared via content-length) is refused without buffering it.
      const huge = Buffer.alloc(Math.ceil(MAX_BINARY_BYTES / 3) * 4 + 128 * 1024, 0x41);
      const big = await post(srv.port, srv.token, 'writeBinary', huge);
      expect(big.json.ok).toBe(false);
      expect(big.json.error.code).toBe('ETOOBIG');
      expect(big.json.error.message).toMatch(/too large.*50 MB/);
      // Chunked (no content-length): still refused, still a clean reply.
      const chunked = await post(srv.port, srv.token, 'writeBinary', huge, { 'transfer-encoding': 'chunked' });
      expect(chunked.json.error.code).toBe('ETOOBIG');
      // Other methods keep the general limit (a big text save is fine).
      const text = await post(srv.port, srv.token, 'writeFile', JSON.stringify({ args: ['big.md', 'x'.repeat(MAX_BINARY_BYTES + 10)] }));
      expect(text.json.ok).toBe(true);
      expect(fs.existsSync(path.join(dir, 'x.png'))).toBe(false);
    } finally {
      await srv.close();
    }
  });
});
