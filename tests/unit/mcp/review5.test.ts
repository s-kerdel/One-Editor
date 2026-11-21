// Security re-check, round 4, ported from .tmp/review-mcp/scratch3/exp-race.ts, exp-race2.ts and
// exp-bounds.ts to the live source: a racer winning the window right after the commit guard (leaf, parent,
// create, move source), the parent swapped when the temp file is opened, a move whose old name cannot be
// removed, the delete pin, no hard links on the volume, and answer sizes of frontmatter key lists.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { OneMcpServer } from '../../../src/mcp/server';
import { WriteQuota } from '../../../src/mcp/writes';
import type { WriteGuard } from '../../../src/backend/workspace';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const cleanup: Array<() => unknown> = [];
beforeAll(() => {
  tmp = path.join(BASE, `review5-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const c of cleanup) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const fresh = (name: string) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const get = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'GONE');

async function server(root: string, mode: 'read' | 'write' = 'write') {
  const s = new OneMcpServer({ configDir: path.join(tmp, 'cfg'), settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, writes: true, trash: async (p) => fs.rmSync(p, { force: true }), quota: new WriteQuota({ session: 10_000, perMinute: 10_000 }) });
  cleanup.push(() => s.dispose());
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode }] });
  let id = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) => s.protocol.handle({ jsonrpc: '2.0', id: id++, method, params }) as Promise<any>;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'review5' } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { isError: !!r.result?.isError, text: (r.result?.content?.[0]?.text ?? r.error?.message) as string };
  };
  const f = s.pool.list()[0];
  return { s, call, f, ws: await f.workspace() };
}

/** A guard that runs the real one, then lets the racer win the window right after it. */
const wrap = (real: WriteGuard, after: (abs: string, role: string) => void): WriteGuard => Object.assign(async (abs: string, role: 'target' | 'from' | 'to') => {
  await real(abs, role);
  after(abs, role);
}, { strict: real.strict });
const swapDir = (dir: string, to: string) => {
  fs.renameSync(dir, `${dir}.moved-away`);
  fs.symlinkSync(to, dir, 'dir');
};

describe('1. a racer right after the commit guard (scratch3/exp-race)', () => {
  for (const scenario of ['leaf', 'parent', 'create', 'move-source'] as const) {
    it(`${scenario}: refused, nothing outside changed, nothing pulled in`, async () => {
      const root = fresh(`race-${scenario}`);
      const outside = fresh(`race-${scenario}-outside`);
      put(outside, 'a.md', 'OUTSIDE ORIGINAL\n');
      put(outside, 'new.md', 'OUTSIDE NEW-NAMED ORIGINAL\n');
      put(root, 'notes/a.md', 'inside\n');
      put(root, 'dst/.keep.md', '');
      const { f, ws } = await server(root);
      await f.use(async () => {
        if (scenario === 'leaf' || scenario === 'parent') {
          const t = await f.resolveTarget('notes/a.md', { kind: 'file', exists: 'must' });
          const g = wrap(f.guard({ expect: { mtime: t.st!.mtimeMs, size: t.st!.size } }), (abs) => {
            if (scenario === 'leaf') {
              fs.rmSync(abs);
              fs.symlinkSync(path.join(outside, 'a.md'), abs);
            } else swapDir(path.dirname(abs), outside);
          });
          await expect(ws.writeFile(t.key, 'WRITTEN BY MCP\n', {}, g)).rejects.toHaveProperty('code');
        } else if (scenario === 'create') {
          const t = await f.resolveTarget('notes/new.md', { kind: 'file', exists: 'mustNot' });
          await expect(ws.createFile(t.key, 'CREATED BY MCP\n', wrap(f.guard({ expect: 'absent' }), (abs) => swapDir(path.dirname(abs), outside)))).rejects.toHaveProperty('code');
        } else {
          const from = await f.resolveTarget('notes/a.md', { kind: 'file', exists: 'must' });
          const to = await f.resolveTarget('dst/a.md', { kind: 'file', exists: 'mustNot' });
          const g = wrap(f.guard({ expect: { mtime: from.st!.mtimeMs, size: from.st!.size }, caseRenameOf: from.key }), (_abs, role) => {
            if (role === 'to') swapDir(path.join(root, 'notes'), outside);
          });
          await expect(ws.rename(from.key, to.key, g)).rejects.toHaveProperty('code');
        }
      });
      expect(get(path.join(outside, 'a.md'))).toBe('OUTSIDE ORIGINAL\n');
      expect(get(path.join(outside, 'new.md'))).toBe('OUTSIDE NEW-NAMED ORIGINAL\n');
      expect(fs.existsSync(path.join(root, 'dst/a.md'))).toBe(false);
      expect(fs.readdirSync(outside).sort()).toEqual(['a.md', 'new.md']);
    });
  }
});

describe('2. the parent swapped when the temp file is opened (scratch3/exp-race2)', () => {
  it('the pinned file is not the one the guard saw: refused before the rename, the outside file kept', async () => {
    const root = fresh('race2');
    const outside = fresh('race2-outside');
    put(outside, 'a.md', 'OUTSIDE ORIGINAL\n');
    put(root, 'notes/a.md', 'inside\n');
    const t = await server(root);
    const etag = /etag (\S+)/.exec((await t.call('read_file', { path: 'notes/a.md' })).text)![1];
    const realOpen = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p.endsWith('.sec-edit.tmp')) {
        spy.mockRestore();
        swapDir(path.dirname(p), outside);
      }
      return (realOpen as any)(p, ...rest);
    });
    try {
      const r = await t.call('write_file', { path: 'notes/a.md', content: 'WRITTEN BY MCP\n', if_match: etag });
      expect(r.isError).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(get(path.join(outside, 'a.md'))).toBe('OUTSIDE ORIGINAL\n');
    expect(fs.readdirSync(outside).filter((n) => !n.startsWith('.~'))).toEqual(['a.md']);
  });

  it('no hard links on the volume (FAT, exFAT, some SMB): the same check on the name, writes still work', async () => {
    const root = fresh('nolink');
    const outside = fresh('nolink-outside');
    put(outside, 'a.md', 'OUTSIDE ORIGINAL\n');
    put(root, 'notes/a.md', 'inside\n');
    const t = await server(root);
    const link = vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    try {
      const e1 = /etag (\S+)/.exec((await t.call('read_file', { path: 'notes/a.md' })).text)![1];
      expect((await t.call('write_file', { path: 'notes/a.md', content: 'v2\n', if_match: e1 })).isError).toBe(false);
      expect(get(path.join(root, 'notes/a.md'))).toBe('v2\n');
      const e2 = /etag (\S+)/.exec((await t.call('read_file', { path: 'notes/a.md' })).text)![1];
      const realOpen = fs.promises.open;
      const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (p: any, ...rest: any[]) => {
        if (typeof p === 'string' && p.endsWith('.sec-edit.tmp')) {
          open.mockRestore();
          swapDir(path.dirname(p), outside);
        }
        return (realOpen as any)(p, ...rest);
      });
      expect((await t.call('write_file', { path: 'notes/a.md', content: 'evil\n', if_match: e2 })).isError).toBe(true);
      open.mockRestore();
    } finally {
      link.mockRestore();
    }
    expect(get(path.join(outside, 'a.md'))).toBe('OUTSIDE ORIGINAL\n');
  });
});

describe('3. moves and deletes', () => {
  it('the old name cannot be removed (a Windows file in use): the new link is taken back, no second name left', async () => {
    const root = fresh('unlink-fail');
    put(root, 'a.md', 'mine\n');
    const t = await server(root);
    const realUnlink = fs.promises.unlink;
    const spy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p: any) => {
      if (String(p) === path.join(root, 'a.md')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return realUnlink(p);
    });
    try {
      expect((await t.call('move_file', { from: 'a.md', to: 'b.md', update_links: false })).isError).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(root, 'b.md'))).toBe(false);
    expect(fs.statSync(path.join(root, 'a.md')).nlink).toBe(1);
    expect(get(path.join(root, 'a.md'))).toBe('mine\n');
  });

  it('a delete only trashes the entry the guard checked (swapped for another file in the window: refused)', async () => {
    const root = fresh('del-pin');
    put(root, 'n.md', 'checked\n');
    const { f, ws } = await server(root);
    const trashed: string[] = [];
    await f.use(async () => {
      const t = await f.resolveTarget('n.md', { kind: 'file', exists: 'must' });
      const g = wrap(f.guard({ expect: { mtime: t.st!.mtimeMs, size: t.st!.size } }), (abs) => {
        fs.writeFileSync(path.join(root, 'planted.txt'), 'planted\n'); // its own inode
        fs.renameSync(path.join(root, 'planted.txt'), abs);
      });
      await expect(ws.remove(t.key, async (p) => void trashed.push(p), g)).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    });
    expect(trashed).toEqual([]);
    expect(get(path.join(root, 'n.md'))).toBe('planted\n');
  });
});

describe('4. answer size: frontmatter key lists fit the read budget (scratch3/exp-bounds)', () => {
  it('get_outline and a frontmatter_key miss on a note with 40,000 keys stay within the budget', async () => {
    const root = fresh('bounds');
    put(root, 'many-keys.md', `---\n${Array.from({ length: 40000 }, (_, i) => `key${i}: v`).join('\n')}\n---\n# H\n`);
    const t = await server(root, 'read');
    const o = await t.call('get_outline', { path: 'many-keys.md' });
    expect(o.isError).toBe(false);
    expect(o.text.length).toBeLessThan(16 * 1024 + 500); // mcp.maxReadKB default
    expect(o.text).toMatch(/frontmatter 1-40002: key0, key1, .* \(\+\d+ more\)/);
    const e = await t.call('read_file', { path: 'many-keys.md', frontmatter_key: 'nope' });
    expect(e.isError).toBe(true);
    expect(e.text.length).toBeLessThan(2600);
    expect(e.text).toMatch(/Keys: key0, key1, .* \(\+\d+ more\)$/);
  });
});
