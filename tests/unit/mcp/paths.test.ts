// Security audit of every path the MCP server accepts: ONE resolver (src/mcp/folders.ts Folder.resolve,
// with cleanPath + Visibility) refuses or contains each attack below. Windows rules are tested with
// string inputs (win: true), never against a Windows file system. Temp folders: .tmp/mcp/unit only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { Folder, Visibility, cleanPath, type FolderEnv } from '../../../src/mcp/folders';
import { parseResourceUri, Resources } from '../../../src/mcp/resources';
import { FolderPool } from '../../../src/mcp/folders';
import { limitsFromSettings } from '../../../src/shared/mcp';
import { ToolError } from '../../../src/mcp/protocol';
import { OneMcpServer } from '../../../src/mcp/server';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof ToolError ? e.code : `threw ${String(e)}`;
  }
};
const lin = (p: unknown) => code(() => cleanPath(p, { win: false }));
const win = (p: unknown) => code(() => cleanPath(p, { win: true }));

describe('cleanPath: string rules (no disk access)', () => {
  it('refuses ".." anywhere: plain, mixed, trailing', () => {
    for (const p of ['..', '../x', 'a/../../x', 'a/..', 'a/../b', 'notes/../../../etc/passwd', '../', 'a/b/..']) {
      expect(lin(p), p).toBe('EINVAL');
      expect(win(p), p).toBe('EINVAL');
    }
  });

  it('refuses absolute POSIX, drive, UNC and device-namespace paths', () => {
    for (const p of ['/etc/passwd', '/', '//server/share', 'C:\\Windows\\win.ini', 'C:foo', 'c:/x', 'Z:', '\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', '\\\\.\\pipe\\x']) {
      expect(lin(p), p).toBe('EINVAL');
      expect(win(p), p).toBe('EINVAL');
    }
  });

  it('refuses backslashes used as separators', () => {
    expect(lin('notes\\a.md')).toBe('EINVAL');
    expect(win('notes\\..\\..\\x')).toBe('EINVAL');
  });

  it('refuses NUL and control characters (C0, DEL, C1)', () => {
    for (const p of ['a\u0000b', 'a.md\u0000.png', 'a\nb', 'a\rb', 'a\tb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u009fb']) expect(lin(p), JSON.stringify(p)).toBe('EINVAL');
  });

  it('contains URL-encoded traversal: never decoded, so "%2e%2e%2f" is one literal (missing) name', () => {
    expect(cleanPath('%2e%2e%2fetc%2fpasswd', { win: false })).toBe('%2e%2e%2fetc%2fpasswd');
    expect(cleanPath('%252e%252e%252f', { win: true })).toBe('%252e%252e%252f');
    expect(cleanPath('..%2f..%2fx', { win: false })).toBe('..%2f..%2fx');
  });

  it('refuses Unicode look-alikes of ".", "/", "\\" and ":" (full-width, two-dot leader)', () => {
    for (const p of ['\uff0e\uff0e/x', 'a/\uff0e\uff0e', 'a\uff0fb', 'a\uff3cb', '\u2025/x', '\uff0e']) {
      expect(lin(p), p).toBe('EINVAL');
      expect(win(p), p).toBe('EINVAL');
    }
    expect(win('a\uff1ab.md')).toBe('EINVAL'); // full-width colon → ':' (a stream on NTFS)
  });

  it('keeps NFC / NFD spellings as they are (the disk decides; visibility checks both)', () => {
    expect(cleanPath('caf\u00e9.md', { win: false })).toBe('caf\u00e9.md');
    expect(cleanPath('cafe\u0301.md', { win: false })).toBe('cafe\u0301.md');
  });

  it('Windows: refuses trailing dots / spaces (Win32 strips them), device names and NTFS streams', () => {
    for (const p of ['a.md.', 'a.md ', 'notes./a.md', 'CON', 'con.md', 'NUL', 'nul.txt', 'COM1', 'com1.log', 'LPT1', 'aux.txt', 'notes/PRN.md', 'CONIN$', '\uff23\uff2f\uff2e', 'file.md:secret', 'file.md::$DATA', 'a:b']) expect(win(p), p).toBe('EINVAL');
    // The same names are ordinary on Linux.
    for (const p of ['a.md.', 'con.md', 'file.md:secret']) expect(lin(p), p).toBe('ok');
  });

  it('refuses non-strings and overlong paths; collapses "." and empty segments', () => {
    expect(lin(5)).toBe('EINVAL');
    expect(lin(null)).toBe('EINVAL');
    expect(lin('a/'.repeat(600))).toBe('EINVAL');
    expect(cleanPath('./notes//a.md/', { win: false })).toBe('notes/a.md');
    expect(cleanPath('', { win: false })).toBe('');
  });
});

describe('Visibility: one rule for every tool', () => {
  const v = new Visibility(['node_modules', 'Private', 'priv\u00e9', '*.log', 'docs/build']);
  it('hides dot segments, key files, excludeGlobs and our temp files, in any case', () => {
    for (const p of ['.git/config', '.env', 'notes/.secret/x.md', '.obsidian/workspace.json', 'id_rsa', 'keys/id_ed25519.pub', 'srv/server.pem', 'a.KEY', 'vault.kdbx', 'x.PFX', 'putty.ppk', 'node_modules/x.md', 'NODE_MODULES/x.md', 'private/x.md', 'PRIVATE/x.md', 'a/b.LOG', 'docs/build/x.md', 'Docs/Build/x.md', '.~a.md.1a2b3c4d.sec-edit.tmp'])
      expect(v.hidden(p), p).toBe(true);
  });
  it('NFC / NFD / NFKC spellings of a hidden name are hidden too', () => {
    expect(v.hidden('prive\u0301/x.md')).toBe(true); // NFD of an NFC pattern
    expect(v.hidden('\uff0eenv')).toBe(true); // full-width dot start
  });
  it('leaves ordinary paths visible', () => {
    for (const p of ['notes/a.md', 'README.md', 'my.keyboard.md', 'id.md', '%2e%2e']) expect(v.hidden(p), p).toBe(false);
  });
});

// ---- the resolver on a real folder ---------------------------------------------------------------

let tmp: string;
let root: string;
let outside: string;
const settings: Settings = { ...DEFAULT_SETTINGS, excludeGlobs: ['node_modules', 'Private'] };
const envOf = (o: Partial<FolderEnv> = {}): FolderEnv => ({ settings: () => settings, configDir: path.join(tmp, 'config'), idleMs: 60_000, win: false, ...o });
const folders: Folder[] = [];
const folder = (o: Partial<FolderEnv> = {}) => {
  const f = new Folder({ alias: 'notes', path: root, mode: 'read' }, envOf(o));
  folders.push(f);
  return f;
};
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ToolError ? `${e.code}: ${e.message}` : `threw ${String(e)}`;
  }
};
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeAll(() => {
  tmp = path.join(BASE, `paths-${crypto.randomBytes(4).toString('hex')}`);
  root = path.join(tmp, 'root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'out.md'), 'OUTSIDE-SECRET');
  write('notes/a.md', '# A\n\nhello');
  write('.secret/s.md', 'TOPSECRET in a dot folder');
  write('id_rsa', '-----BEGIN KEY-----');
  write('node_modules/m.md', 'excluded');
  write('Private/p.md', 'excluded by name');
  write('%2e%2e/x.md', 'a literal name');
  fs.symlinkSync(path.join(outside, 'out.md'), path.join(root, 'link-out.md'));
  fs.symlinkSync(outside, path.join(root, 'dir-out'), 'dir');
  fs.symlinkSync('../.secret/s.md', path.join(root, 'notes/leak.md'));
  fs.symlinkSync('.secret', path.join(root, 'link-dot'), 'dir');
  fs.symlinkSync('a.md', path.join(root, 'notes/ok-link.md'));
});

afterAll(() => {
  for (const f of folders) f.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Folder.resolve / readText: the one resolver', () => {
  it('reads an ordinary file; links are never followed, not even one that stays inside', async () => {
    const f = folder();
    expect((await f.readText('notes/a.md')).content).toContain('hello');
    expect((await f.readText('./notes//a.md')).content).toContain('hello');
    expect(await fail(f.readText('notes/ok-link.md'))).toBe('ENOENT: Not found: notes/ok-link.md');
  });

  it('symlinks out of the folder: on the leaf and on a parent folder → ENOENT', async () => {
    const f = folder();
    expect(await fail(f.readText('link-out.md'))).toBe('ENOENT: Not found: link-out.md');
    expect(await fail(f.readText('dir-out/out.md'))).toBe('ENOENT: Not found: dir-out/out.md');
    expect(await fail(f.list('dir-out', 1))).toMatch(/^ENOENT/);
  });

  it('links inside the folder that lead to a hidden place → ENOENT (leaf and parent)', async () => {
    const f = folder();
    expect(await fail(f.readText('notes/leak.md'))).toBe('ENOENT: Not found: notes/leak.md');
    expect(await fail(f.readText('link-dot/s.md'))).toBe('ENOENT: Not found: link-dot/s.md');
  });

  it('hidden paths answer exactly like missing ones (nothing can be probed)', async () => {
    const f = folder();
    expect(await fail(f.readText('.secret/s.md'))).toBe('ENOENT: Not found: .secret/s.md');
    expect(await fail(f.readText('id_rsa'))).toBe('ENOENT: Not found: id_rsa');
    expect(await fail(f.readText('node_modules/m.md'))).toBe('ENOENT: Not found: node_modules/m.md');
    expect(await fail(f.readText('private/p.md'))).toBe('ENOENT: Not found: private/p.md');
    expect(await fail(f.readText('PRIVATE/p.md'))).toBe('ENOENT: Not found: PRIVATE/p.md');
    expect(await fail(f.readText('nope.md'))).toBe('ENOENT: Not found: nope.md');
  });

  it('URL-encoded names stay literal names inside the folder', async () => {
    const f = folder();
    expect((await f.readText('%2e%2e/x.md')).content).toBe('a literal name');
    expect(await fail(f.readText('%2e%2e%2f%2e%2e%2foutside%2fout.md'))).toMatch(/^ENOENT/);
  });

  it('every refusal names the asked path only, never a host path', async () => {
    const f = folder();
    const msgs = await Promise.all(['link-out.md', 'dir-out/out.md', '../outside/out.md', '/etc/passwd', 'C:\\x', 'notes/leak.md', '.secret/s.md', 'nope/x.md'].map((p) => fail(f.readText(p))));
    for (const m of msgs) {
      expect(m).not.toContain(tmp);
      expect(m).not.toContain(root);
    }
  });

  it('check-then-use: a link swapped in after the check is caught at the read', async () => {
    write('notes/swap.md', 'original');
    const f = folder();
    const r = await f.resolve('notes/swap.md');
    fs.rmSync(path.join(root, 'notes/swap.md'));
    fs.symlinkSync(path.join(outside, 'out.md'), path.join(root, 'notes/swap.md'));
    expect(await fail(f.readResolved(r))).toBe('ENOENT: Not found: notes/swap.md');
  });

  it('check-then-use: another file put in its place after the check is caught too', async () => {
    write('notes/swap2.md', 'original');
    const f = folder();
    const r = await f.resolve('notes/swap2.md');
    fs.rmSync(path.join(root, 'notes/swap2.md'));
    fs.writeFileSync(path.join(root, 'notes/swap2.md'), 'replaced, other inode and size');
    expect(await fail(f.readResolved(r))).toBe('ENOENT: Not found: notes/swap2.md');
  });

  it('Windows rules apply through the resolver too (device names, streams, trailing dots)', async () => {
    const f = folder({ win: true });
    for (const p of ['aux.md', 'notes/a.md:secret', 'notes/a.md.', 'COM1']) expect(await fail(f.readText(p)), p).toMatch(/^EINVAL/);
  });

  it('listing leaves out hidden entries and links that lead out or to hidden places', async () => {
    const f = folder();
    const all = (await f.list('', 3)).entries.map((e) => e.path);
    expect(all).toContain('notes/a.md');
    for (const p of ['.secret', 'id_rsa', 'node_modules', 'Private', 'link-out.md', 'dir-out', 'notes/leak.md', 'link-dot', 'notes/ok-link.md']) expect(all, p).not.toContain(p);
  });

  it('case-insensitive folder: every spelling of a hidden name is hidden (no case collision)', async () => {
    const f = folder({ caseSensitive: false });
    for (const p of ['ID_RSA', '.SECRET/s.md', 'Node_Modules/m.md', 'private/p.md']) expect(await fail(f.readText(p)), p).toBe(`ENOENT: Not found: ${p}`);
  });
});

describe('resources: one:// URIs decode, then go through the same resolver', () => {
  it('decoded ".." is refused; double-encoded stays a literal name', async () => {
    expect(parseResourceUri('one://notes/%2e%2e/%2e%2e/etc/passwd').path).toBe('../../etc/passwd');
    const pool = new FolderPool(envOf());
    pool.apply({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode: 'read' }] });
    const res = new Resources(pool, () => limitsFromSettings({}));
    const r = async (uri: string) => fail(res.read(uri, { client: 't' }));
    expect(await r('one://notes/%2e%2e/%2e%2e/etc/passwd')).toMatch(/^EINVAL/);
    expect(await r('one://notes/notes%5c..%5c..%5cx')).toMatch(/^EINVAL/);
    // Decoded once → "%2e%2e/x.md": the literal folder of that name inside (contained, never "..").
    expect(await r('one://notes/%252e%252e/x.md')).toBe('ok');
    expect(await r('one://notes/%252e%252e/%252e%252e/outside/out.md')).toMatch(/^ENOENT/);
    expect(await r('one://notes/.secret/s.md')).toBe('ENOENT: Not found: .secret/s.md');
    expect(await r('one://notes/notes/a.md')).toBe('ok');
    expect(await r('one://notes/%E0%A4%A')).toMatch(/^EINVAL/);
    pool.dispose();
  });
});

describe('index-based tools never show hidden content (links into hidden places)', () => {
  it('search_text finds nothing behind notes/leak.md or link-dot/', async () => {
    const server = new OneMcpServer({ configDir: path.join(tmp, 'config'), settings, transport: 'stdio', win: false });
    server.applyConfig({ version: 1, enabled: true, folders: [{ id: 'bbbbbbbb', alias: 'notes', path: root, mode: 'read' }] });
    await server.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } } });
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await server.protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })) as any).result.content[0].text);
    const hits = await call('search_text', { query: 'TOPSECRET' });
    expect(hits.results).toEqual([]);
    expect(hits.total_files).toBe(0);
    const out = await call('search_text', { query: 'OUTSIDE-SECRET' });
    expect(out.results).toEqual([]);
    const files = await call('search_files', { query: 'leak' });
    expect(files.results).toEqual([]);
    expect((await call('search_files', { query: 'a.md' })).results).toContain('notes/a.md');
    await server.dispose();
  });
});
