// A taken-over page must not widen its reach: main only opens folders it saw itself, and only serves
// the vault keys of the open folder.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { OpenGate, type OpenGateDeps } from '../../../src/main/open-gate';
import { VaultService } from '../../../src/main/vault';
import { vaultKeyFolder, vaultKeyInScope, vaultRootScope } from '../../../src/shared/vault';

function gate(o: { files?: string[]; links?: Record<string, string>; recent?: string[]; root?: string | null; p?: typeof path.posix; foldCase?: boolean } = {}) {
  const p = o.p ?? path.posix;
  const fold = (s: string) => (o.foldCase ? s.toLowerCase() : s);
  const links = Object.entries(o.links ?? {}).map(([k, v]) => [fold(k), v] as const);
  const deps: OpenGateDeps = {
    p,
    foldCase: !!o.foldCase,
    // Fake file system: every path exists; a path at or below a link is rewritten to the link's target.
    realpath: async (abs) => {
      for (const [from, to] of links) if (fold(abs) === from || fold(abs).startsWith(from + p.sep)) return to + abs.slice(from.length);
      return abs;
    },
    isFile: async (abs) => (o.files ?? []).map(fold).includes(fold(abs)),
    recent: async () => o.recent ?? [],
    root: () => o.root ?? null,
  };
  return new OpenGate(deps);
}

describe('OpenGate: which folders the renderer may open', () => {
  it('nothing main has not seen: the home folder, the root, a sibling of the open folder', async () => {
    const g = gate({ root: '/home/me/notes', recent: ['/home/me/notes'] });
    for (const p of ['/home/me', '/', '/home/me/.ssh', '/home/me/notes-private', '/etc', '', 'relative/dir', '/a\0b', 42, null, undefined, {}]) expect(await g.allows(p), String(p)).toBe(false);
  });

  it('the dialog / argv / drop answer, in any spelling of the same folder', async () => {
    const g = gate();
    g.vouch('/data/project');
    expect(await g.allows('/data/project')).toBe(true);
    expect(await g.allows('/data/project/')).toBe(true);
    expect(await g.allows('/data/x/../project')).toBe(true);
    expect(await g.allows('/data')).toBe(false); // never the parent of a vouched FOLDER
    expect(await g.allows('/data/project/sub')).toBe(false); // not open yet: nothing below it either
    g.vouch('relative');
    g.vouch(7);
    expect(await g.allows('relative')).toBe(false);
  });

  it('a vouched file opens its folder (lone file from Explorer / a drop), nothing above', async () => {
    const g = gate({ files: ['/docs/letters/a.md'] });
    g.vouch('/docs/letters/a.md');
    expect(await g.allows('/docs/letters')).toBe(true);
    expect(await g.allows('/docs')).toBe(false);
  });

  it('recent folders, and folders inside the open one ("Open as project") judged by their real path', async () => {
    const g = gate({ root: '/home/me/notes', recent: ['/home/me/notes', '/work/repo'], links: { '/home/me/notes/out': '/home/me/.ssh' } });
    expect(await g.allows('/work/repo')).toBe(true);
    expect(await g.allows('/home/me/notes/projects/a')).toBe(true);
    expect(await g.allows('/home/me/notes/out')).toBe(false); // a link in the folder that points elsewhere
    expect(await g.allows('/home/me/notes/out/keys')).toBe(false);
    expect(await g.allows('/work')).toBe(false);
  });

  it('the realpath the backend answered for a vouched path counts as that path (macOS /var → /private/var, Windows case)', async () => {
    const g = gate({ links: { '/var/tmp': '/private/var/tmp' } });
    g.vouch('/var/tmp/proj');
    expect(await g.allows('/private/var/tmp/proj')).toBe(true);
    const w = gate({ p: path.win32 as never, foldCase: true, files: ['c:\\notes\\todo.md'] });
    w.vouch('C:\\Notes\\TODO.md');
    expect(await w.allows('c:\\notes')).toBe(true);
    expect(await w.allows('C:\\')).toBe(false);
    w.vouch('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
    expect(await w.allows('//wsl.localhost/Ubuntu/home/me/proj')).toBe(true);
    expect(await w.allows('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe(false);
  });

  it('keeps a bounded memory of vouched paths (oldest go first)', async () => {
    const g = gate();
    g.vouch('/first');
    for (let i = 0; i < 600; i++) g.vouch(`/d/${i}`);
    expect(await g.allows('/first')).toBe(false);
    expect(await g.allows('/d/599')).toBe(true);
  });
});

describe('vault keys are served for the open folder only', () => {
  it('key → folder scope', () => {
    expect(vaultKeyFolder('/home/me/lab::prod/db_pass')).toBe('/home/me/lab');
    expect(vaultKeyFolder('c:/work/lab::db_pass')).toBe('c:/work/lab');
    expect(vaultKeyFolder('//wsl.localhost/ubuntu/home/me::x')).toBe('//wsl.localhost/ubuntu/home/me');
    expect(vaultKeyFolder('/odd::name/dir::srv.pass')).toBe('/odd::name/dir');
    for (const k of ['prod-db', 'team::db', '::x', 'a/b::c', 'c::x']) expect(vaultKeyFolder(k), k).toBeNull(); // explicit `vault:<key>`: shared by design
    expect(vaultRootScope('C:\\Work\\Lab\\', 'win32')).toBe('c:/work/lab');
    expect(vaultRootScope('/Home/Me/Lab/', 'linux')).toBe('/Home/Me/Lab');
  });

  it('in scope: the open folder and below; never a sibling, a parent, another drive, or without a folder', () => {
    const root = '/home/me/lab';
    expect(vaultKeyInScope('/home/me/lab::db', root, 'linux')).toBe(true);
    expect(vaultKeyInScope('/home/me/lab/sub/proj::prod/web.pass', root, 'linux')).toBe(true);
    expect(vaultKeyInScope('prod-db', root, 'linux')).toBe(true);
    expect(vaultKeyInScope('prod-db', null, 'linux')).toBe(true);
    for (const k of ['/home/me/lab2::db', '/home/me::db', '/::db', '/home/me/other::db', '/home/me/Lab::db', '/home/me/lab/../other::db']) expect(vaultKeyInScope(k, root, 'linux'), k).toBe(false);
    expect(vaultKeyInScope('/home/me/lab::db', null, 'linux')).toBe(false);
    expect(vaultKeyInScope('c:/work/lab/x::db', 'C:\\Work\\Lab', 'win32')).toBe(true);
    expect(vaultKeyInScope('d:/work/lab::db', 'C:\\Work\\Lab', 'win32')).toBe(false);
    expect(vaultKeyInScope('c:/users/me::db', 'C:\\', 'win32')).toBe(true); // a drive root as the folder
  });

  it('VaultService: get / set / remove refuse another folder’s key, has() reports it as not set', async () => {
    const dir = path.resolve(__dirname, '../../../.tmp/sec-desktop/unit-vault');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `scope-${process.pid}.json`);
    const crypto = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s, 'utf8'), decrypt: (b: Buffer) => b.toString('utf8') };
    let root: string | null = '/home/me/other';
    const v = new VaultService(file, crypto, { root: () => root, os: 'linux' });
    await v.set('/home/me/other::db', 'theirs');
    await v.set('shared-key', 'shared');
    root = '/home/me/lab';
    await v.set('/home/me/lab::db', 'mine');
    expect(await v.has(['/home/me/lab::db', '/home/me/other::db', 'shared-key', '__proto__', 'constructor'])).toEqual(['/home/me/lab::db', 'shared-key']);
    expect(await v.get('/home/me/lab::db')).toBe('mine');
    // A shared key another folder saved needs the user's OK (vault-shared-keys.test.ts); none here → refused.
    await expect(v.get('shared-key')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await v.get('constructor')).toBeNull();
    await expect(v.get('/home/me/other::db')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(v.set('/home/me/other::db', 'overwritten')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(v.remove('/home/me/other::db')).rejects.toMatchObject({ code: 'EACCES' });
    root = null; // no folder open: only unscoped keys
    await expect(v.get('/home/me/lab::db')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await v.has(['/home/me/lab::db', 'shared-key'])).toEqual(['shared-key']);
    root = '/home/me/other';
    expect(await v.get('/home/me/other::db')).toBe('theirs'); // untouched by the refused calls
    await fsp.rm(file, { force: true });
  });
});

describe('OpenGate.vouchedFile: an outside file needs main to have seen that very file', () => {
  it('only the vouched file: not its neighbours, its folder, a recent folder or the open folder', async () => {
    const g = gate({ root: '/home/me/notes', recent: ['/data'], files: ['/data/x/a.md'] });
    g.vouch('/data/x/a.md');
    expect(await g.vouchedFile('/data/x/a.md')).toBe(true);
    for (const p of ['/data/x/b.md', '/data/x', '/data', '/home/me/notes/n.md', '/data/x/../x/b.md', '', 'a.md', '/a\0b', 7, null]) expect(await g.vouchedFile(p), String(p)).toBe(false);
  });
  it('the real file behind a vouched link', async () => {
    const g = gate({ links: { '/home/me/l.md': '/data/real.md' } });
    g.vouch('/home/me/l.md');
    expect(await g.vouchedFile('/data/real.md')).toBe(true);
    expect(await g.vouchedFile('/data/other.md')).toBe(false);
  });
});
