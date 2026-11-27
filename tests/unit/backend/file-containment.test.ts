// Security audit 2026-11-27, backend file containment (H1 a/b, H3, H4, M9, M13, L2, L6, L14, L15, L16). Each case
// fails on the code before the fix. Races are driven by deterministic hooks (a write guard that runs inside the
// operation's slot, spies on single fs calls that swap a link in at an exact moment), never by timing loops.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Workspace, atomicWrite } from '../../../src/backend/workspace';
import { BackendService, rootId } from '../../../src/backend/service';
import { cacheFileFor } from '../../../src/backend/indexcache';
import { isGitDirName, isUncOrDevicePath } from '../../../src/backend/pathsafe';
import type { FileData, TreeNode } from '../../../src/shared/api';

const BASE = path.resolve(__dirname, '../../../.tmp/sec-backend/containment');
let tmp: string;
let root: string;
let outside: string;
const open: Array<{ dispose(): void }> = [];
let canLink = true;

const put = (abs: string, text = 'x') => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const flat = (n: TreeNode, out: string[] = []): string[] => {
  for (const c of n.children ?? []) {
    out.push(c.path);
    flat(c, out);
  }
  return out;
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e?.code ?? String(e));
const ws = (r: string, o: ConstructorParameters<typeof Workspace>[1] = {}) => {
  const w = new Workspace(r, o);
  open.push(w);
  return w;
};
const svc = (cfg: string, hooks: ConstructorParameters<typeof BackendService>[1] = {}) => {
  const s = new BackendService(cfg, hooks, { cacheDir: '' });
  open.push(s);
  return s;
};
/** The folder `rel` (inside root) becomes a link to `to`; its old content moves to `rel`-old. */
const swapForLink = (rel: string, to: string) => {
  const abs = path.join(root, rel);
  fs.renameSync(abs, `${abs}-old`);
  fs.symlinkSync(to, abs, 'dir');
};
const allText = async (w: Workspace) => {
  const out: FileData[] = [];
  let cursor: string | null = null;
  do {
    const p = await w.readAllTextPage({ cursor });
    out.push(...p.files);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
};

beforeEach(async () => {
  await fsp.mkdir(BASE, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(BASE, 't-'));
  root = path.join(tmp, 'ws');
  outside = path.join(tmp, 'outside');
  put(path.join(root, 'b', 'x.md'), 'inside\n');
  put(path.join(root, 'a.md'), 'a\n');
  put(path.join(outside, 'x.md'), 'OUTSIDE\n');
  put(path.join(outside, 'a.md'), 'SECRET\n');
  try {
    fs.symlinkSync(path.join(tmp, 'probe-target'), path.join(tmp, 'probe-link'));
  } catch {
    canLink = false; // no symlink permission (Windows without developer mode)
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const o of open.splice(0)) o.dispose();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('H3: page writes, moves, deletes and reads are race-safe', () => {
  const lf = { eol: 'lf' as const, bom: false, encoding: 'utf8' as const };

  it('write: the folder swapped for a link to outside after the checks → refused, nothing lands outside', async () => {
    if (!canLink) return;
    const w = ws(root);
    const guard = async () => swapForLink('b', outside); // runs inside the slot, after real() and the stat
    expect(await code(w.writeFile('b/x.md', 'PAGE\n', lf, guard))).toBe('OUTSIDE_WORKSPACE');
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('OUTSIDE\n');
  });

  it('write: swapped right before the temp file replaces the target → the in-place fallback refuses (L14 too)', async () => {
    if (!canLink) return;
    const w = ws(root);
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (String(a).endsWith('.sec-edit.tmp')) swapForLink('b', outside); // the temp stays behind in b-old
      return rename(a, b);
    });
    expect(await code(w.writeFile('b/x.md', 'PAGE\n', lf))).toBe('OUTSIDE_WORKSPACE');
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('OUTSIDE\n');
  });

  it('write: the folder moved outside (with the temp file) at the last moment → what landed there is taken back', async () => {
    if (!canLink) return;
    const w = ws(root);
    const moved = path.join(outside, 'b-moved');
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (String(a).endsWith('.sec-edit.tmp')) {
        fs.renameSync(path.join(root, 'b'), moved);
        fs.symlinkSync(moved, path.join(root, 'b'), 'dir');
      }
      return rename(a, b);
    });
    expect(await code(w.writeFile('b/x.md', 'PAGE\n', lf))).toBe('OUTSIDE_WORKSPACE');
    expect(fs.existsSync(path.join(moved, 'x.md')) ? fs.readFileSync(path.join(moved, 'x.md'), 'utf8') : '').not.toContain('PAGE');
  });

  it('move: the target folder swapped for a link to outside → refused, nothing lands outside', async () => {
    if (!canLink) return;
    fs.mkdirSync(path.join(root, 'd'));
    const w = ws(root);
    const guard = async (_abs: string, role: string) => void (role === 'to' && swapForLink('d', outside));
    expect(await code(w.rename('a.md', 'd/a2.md', guard))).toBe('OUTSIDE_WORKSPACE');
    expect(fs.readdirSync(outside).sort()).toEqual(['a.md', 'x.md']);
    expect(fs.readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('a\n');
  });

  it('delete: the folder swapped for a link to outside → refused, the outside file stays', async () => {
    if (!canLink) return;
    const w = ws(root);
    expect(await code(w.remove('b/x.md', undefined, async () => swapForLink('b', outside)))).toBe('OUTSIDE_WORKSPACE');
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('OUTSIDE\n');
  });

  it('read: a link swapped in between the check and the read → refused (read through the opened, checked handle)', async () => {
    if (!canLink) return;
    const w = ws(root);
    const target = path.join(root, 'b', 'x.md');
    let swapped = false;
    const swap = () => !swapped && (swapped = true) && swapForLink('b', outside);
    const open = fsp.open.bind(fsp);
    const readFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (p, ...r) => (String(p) === target && swap(), open(p, ...(r as unknown as []))));
    vi.spyOn(fsp, 'readFile').mockImplementation(async (p, ...r) => (String(p) === target && swap(), readFile(p, ...(r as unknown as []))) as never);
    const r = await w.readFile('b/x.md').then((d) => d.content, (e) => e.code);
    expect(r).not.toContain('OUTSIDE');
    expect(['EXTERNAL_CHANGE', 'OUTSIDE_WORKSPACE']).toContain(r);
  });

  it('write without eol / encoding: the existing file is read bounded (no unbounded read widens the window)', async () => {
    const w = ws(root);
    const big = path.join(root, 'big.txt');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 49 * 1024 * 1024); // sparse: nothing heavy on disk
    expect(await code(w.writeFile('big.txt', 'small'))).toBe('ETOOBIG');
    expect(await code(w.writeFile('big.txt', 'small', lf))).toBe('ok'); // all three given: nothing to read
  });

  it('a moved link runs alone: it waits for a write in progress (no redirect half-way)', async () => {
    if (!canLink) return;
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'l'), 'dir'); // inside: listed
    fs.symlinkSync(outside, path.join(root, 'evil'), 'dir'); // outside: not listed, but a page can name it
    const w = ws(root);
    await w.listTree();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inSlot = new Promise<void>((r) => (entered = r));
    const write = w.writeFile('l/x.md', 'PAGE\n', lf, async () => (entered(), held));
    await inSlot;
    let moved = false;
    const move = w.rename('evil', 'z').then(() => void (moved = true));
    await new Promise((r) => setTimeout(r, 150)); // the move would be long done if it did not wait
    expect(moved).toBe(false);
    release();
    await Promise.all([write, move]);
    expect(fs.readFileSync(path.join(root, 'b', 'x.md'), 'utf8')).toBe('PAGE\n');
    expect(fs.lstatSync(path.join(root, 'z')).isSymbolicLink()).toBe(true);
  });
});

describe('H4: the index pass checks where files below a link really are', () => {
  for (const readThreads of [0, 2]) {
    it(`a relative link moved so it leads outside: its files are not read (readThreads ${readThreads})`, async () => {
      if (!canLink) return;
      // root = tmp/a/ws; x/l → ../../ws/notes is root/notes; moved to the root it is tmp/ws/notes (outside).
      const r = path.join(tmp, 'a', 'ws');
      put(path.join(r, 'notes', 'a.md'), 'mine\n');
      put(path.join(tmp, 'ws', 'notes', 'a.md'), 'SECRET\n');
      fs.mkdirSync(path.join(r, 'x'));
      fs.symlinkSync(path.join('..', '..', 'ws', 'notes'), path.join(r, 'x', 'l'), 'dir');
      const w = ws(r, { readThreads });
      expect(flat(await w.listTree())).toContain('x/l/a.md');
      await w.rename('x/l', 'l');
      const text = await allText(w);
      expect(JSON.stringify(text)).not.toContain('SECRET');
      expect(JSON.stringify((await w.readIndexedFiles(['l/a.md'])).files)).not.toContain('SECRET');
    });
  }

  it('a link to outside moved in place of the folder another link points to: not read through that link', async () => {
    if (!canLink) return;
    put(path.join(root, 'notes', 'a.md'), 'mine\n');
    fs.symlinkSync(path.join(root, 'notes'), path.join(root, 'l'), 'dir');
    fs.symlinkSync(outside, path.join(root, 'evil'), 'dir');
    const w = ws(root, { readThreads: 2 });
    expect(flat(await w.listTree())).toContain('l/a.md');
    await w.rename('notes', 'notes2');
    await w.rename('evil', 'notes');
    expect(JSON.stringify(await allText(w))).not.toContain('SECRET');
  });
});

describe('H1 (a): no file RPC changes a .git folder', () => {
  it('write, create, mkdir, move, delete in .git (also GIT~1, or through a link) → EACCES; .gitignore is fine', async () => {
    put(path.join(root, '.git', 'config'), '[core]\n');
    const s = svc(path.join(tmp, 'cfg'));
    await s.openWorkspace(root);
    const refused = async (p: Promise<unknown>) => expect(await code(p)).toBe('EACCES');
    await refused(s.writeFile('.git/config', '[core]\n\tfsmonitor = touch pwned\n'));
    await refused(s.writeBinary('.git/hooks/pre-commit', Buffer.from('#!/bin/sh').toString('base64')));
    await refused(s.createFile('.git/hooks/post-checkout', 'x'));
    await refused(s.createDir('.git/hooks/x'));
    await refused(s.writeFile('sub/.git/config', 'x')); // a nested repository
    await refused(s.writeFile('GIT~1/config', 'x')); // 8.3 short name
    await refused(s.rename('a.md', '.git/hooks/pre-commit'));
    await refused(s.rename('.git', 'not-git'));
    await refused(s.remove('.git/config', { permanent: true }));
    if (canLink) {
      fs.symlinkSync(path.join(root, '.git'), path.join(root, 'b', 'g'), 'dir'); // inside the folder, so listed
      await refused(s.writeFile('b/g/config', 'x'));
      await refused(s.rename('a.md', 'b/g/hooks-pre-commit'));
    }
    expect(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(await code(s.writeFile('.gitignore', 'dist\n'))).toBe('ok');
    expect(await code(s.writeFile('.github/workflows/ci.yml', 'x'))).toBe('ok');
  });

  it('a folder that folds case also refuses .GIT; the name rule itself', async () => {
    const w = ws(root, { caseSensitive: false, protectGitDir: true });
    expect(await code(w.writeFile('.GIT/config', 'x'))).toBe('EACCES');
    expect([isGitDirName('.git', false), isGitDirName('.Git', false), isGitDirName('.Git', true), isGitDirName('git~1', false), isGitDirName('.g\u200cit', false), isGitDirName('.gıt', true), isGitDirName('.gitignore', true)]).toEqual([true, false, true, true, true, true, false]);
  });
});

describe('H1 (b): git trust only through ServiceHooks.confirmTrust', () => {
  const trusted = (cfg: string) => {
    const f = path.join(cfg, 'git-trust.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).trusted : [];
  };

  it('no hook (browser mode, MCP, tests) → EACCES, nothing written; untrust still works', async () => {
    const cfg = path.join(tmp, 'cfg');
    const s = svc(cfg);
    await s.openWorkspace(root);
    await expect(s.git('trust')).rejects.toMatchObject({ code: 'EACCES', message: 'Trust this folder in the desktop app' });
    expect(trusted(cfg)).toEqual([]);
    expect(await s.git('untrust')).toBe(false);
  });

  it('the hook decides: no (or a throw) → false and untrusted; yes → trusted; one dialog for overlapping asks', async () => {
    const cfg = path.join(tmp, 'cfg');
    const answers = [false, true];
    const asked: string[] = [];
    let thrower = false;
    const s = svc(cfg, {
      confirmTrust: async (r) => {
        asked.push(r);
        if (thrower) throw new Error('dialog failed');
        return answers.shift()!;
      },
    });
    await s.openWorkspace(root);
    expect(await s.git('trust')).toBe(false);
    expect(trusted(cfg)).toEqual([]);
    expect(await Promise.all([s.git('trust'), s.git('trust')])).toEqual([true, true]);
    expect(asked).toEqual([path.resolve(root), path.resolve(root)]);
    expect(trusted(cfg)).toEqual([fs.realpathSync(root)]);
    await s.git('untrust');
    thrower = true;
    expect(await s.git('trust')).toBe(false);
  });
});

describe('M9: One’s data folder is never the open folder; L16: deny folders matched by identity', () => {
  it('openWorkspace refuses a root inside the data folder (as written or through a link); the open folder stays', async () => {
    const cfg = path.join(tmp, 'cfg');
    put(path.join(cfg, 'inner', 'mcp.json'), '{"token":"t"}');
    const s = svc(cfg);
    await s.openWorkspace(root);
    expect(await code(s.openWorkspace(path.join(cfg, 'inner')))).toBe('EACCES');
    expect(await code(s.openWorkspace(cfg))).toBe('EACCES');
    if (canLink) {
      fs.symlinkSync(cfg, path.join(tmp, 'alias'), 'dir');
      expect(await code(s.openWorkspace(path.join(tmp, 'alias', 'inner')))).toBe('EACCES');
    }
    expect(s.workspace?.root).toBe(path.resolve(root));
  });

  it('a Workspace whose root is inside a deny folder lists and indexes nothing (files included)', async () => {
    const cfg = path.join(tmp, 'cfg');
    put(path.join(cfg, 'inner', 'settings.json'), '{"secret":1}');
    put(path.join(cfg, 'inner', 'sub', 'b.md'), 'b');
    const w = ws(path.join(cfg, 'inner'), { deny: [cfg] });
    expect(flat(await w.listTree())).toEqual([]);
    expect(await allText(w)).toEqual([]);
  });

  it('a deny folder below a followed link (a link to its parent) is not listed or read', async () => {
    if (!canLink) return;
    const data = path.join(root, 'AppData', 'Roaming', 'sec-edit');
    put(path.join(data, 'settings.json'), '{"SECRET":1}');
    fs.symlinkSync(path.join(root, 'AppData'), path.join(root, 'l'), 'dir');
    const w = ws(root, { deny: [data] });
    const listed = flat(await w.listTree());
    expect(listed).toContain('l/Roaming');
    expect(listed.filter((p) => p.includes('sec-edit'))).toEqual([]);
    expect(JSON.stringify(await allText(w))).not.toContain('SECRET');
    expect(await code(w.readFile('l/Roaming/sec-edit/settings.json'))).toBe('EACCES');
  });

  it('an alias root that realpath does not resolve (bind mount, 8.3, \\\\localhost\\c$, firmlink): denied by identity', async () => {
    if (!canLink) return;
    const home = path.join(tmp, 'home');
    const data = path.join(home, 'AppData', 'Roaming', 'sec-edit');
    put(path.join(data, 'settings.json'), '{"SECRET":1}');
    put(path.join(home, 'notes.md'), 'n');
    const bind = path.join(tmp, 'bind');
    fs.symlinkSync(home, bind, 'dir'); // the OS follows it like a bind mount…
    const realpath = fsp.realpath.bind(fsp);
    // …and realpath leaves it as written, like it does for a bind mount or a UNC loopback root.
    vi.spyOn(fsp, 'realpath').mockImplementation(async (p, o) => (String(p).startsWith(bind) ? String(p) : realpath(p, o)) as never);
    const w = ws(bind, { deny: [data] });
    const listed = flat(await w.listTree());
    expect(listed).toContain('notes.md');
    expect(listed.filter((p) => p.includes('sec-edit'))).toEqual([]);
    expect(await code(w.readFile('AppData/Roaming/sec-edit/settings.json'))).toBe('EACCES');
    expect(JSON.stringify(await allText(w))).not.toContain('SECRET');
  });
});

describe('M13: a failed realpath(root) fails closed and is not kept', () => {
  it('links count as outside while it fails; plain paths work; it is asked again', async () => {
    if (!canLink) return;
    fs.symlinkSync(path.join(outside, 'a.md'), path.join(root, 'out.md'));
    fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'in.md'));
    let failing = true;
    const realpath = fsp.realpath.bind(fsp);
    vi.spyOn(fsp, 'realpath').mockImplementation(async (p, o) => {
      if (failing && String(p) === root) throw Object.assign(new Error('EIO: odd drive'), { code: 'EIO' });
      return realpath(p, o) as never;
    });
    const w = ws(root);
    expect(await code(w.readFile('out.md'))).toBe('OUTSIDE_WORKSPACE');
    expect(await code(w.writeFile('out.md', 'x'))).toBe('OUTSIDE_WORKSPACE');
    expect((await w.readFile('a.md')).content).toBe('a\n');
    expect(flat(await w.listTree())).not.toContain('out.md');
    failing = false;
    expect((await w.readFile('in.md')).content).toBe('a\n');
    expect(await code(w.readFile('out.md'))).toBe('OUTSIDE_WORKSPACE');
    expect(fs.readFileSync(path.join(outside, 'a.md'), 'utf8')).toBe('SECRET\n');
  });
});

describe('L6: resolvePath never touches a UNC / device path the page sends', () => {
  it('refused on the text before any disk access, unless main vouched for it (remotePathOk)', async () => {
    expect([isUncOrDevicePath('\\\\attacker\\s\\x.md', true), isUncOrDevicePath('//attacker/s', true), isUncOrDevicePath('\\\\?\\C:\\x', true), isUncOrDevicePath('\\\\.\\pipe\\x', true), isUncOrDevicePath('C:\\x', true), isUncOrDevicePath('\\\\attacker\\s', false)]).toEqual([true, true, true, true, false, false]);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const stat = vi.spyOn(fsp, 'stat');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const s = svc(path.join(tmp, 'cfg'));
      expect(await s.resolvePath('\\\\attacker\\share\\x.md')).toBeNull();
      expect(await s.resolvePath('//attacker/share/x.md')).toBeNull();
      expect(stat).not.toHaveBeenCalled();
      const vouched = svc(path.join(tmp, 'cfg2'), { remotePathOk: () => true });
      await vouched.resolvePath('\\\\server\\share\\x.md');
      expect(stat).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('L14: atomicWrite rewrites in place only a regular file', () => {
  it('a link at the target when the rename fails: refused, the link target untouched', async () => {
    if (!canLink) return;
    const target = path.join(root, 'linked.md');
    fs.symlinkSync(path.join(outside, 'x.md'), target);
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('EPERM: locked'), { code: 'EPERM' }));
    await expect(atomicWrite(target, Buffer.from('PAGE'))).rejects.toMatchObject({ code: 'EPERM' });
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('OUTSIDE\n');
    expect(fs.readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('L15: per-folder ids fold case only where the folder does', () => {
  it('ids and cache names: folding keeps the old value, case-sensitive tells Proj from proj', () => {
    const old = (r: string) => crypto.createHash('sha1').update(r.toLowerCase()).digest('hex').slice(0, 16);
    expect(rootId('/x/Proj', true)).toBe(old('/x/Proj'));
    expect(rootId('/x/Proj')).toBe(old('/x/Proj')); // default: the old rule (other callers)
    expect(rootId('/x/Proj', false)).not.toBe(rootId('/x/proj', false));
    expect(cacheFileFor('/c', '/x/Proj', true)).toBe(cacheFileFor('/c', '/x/proj', true));
    expect(cacheFileFor('/c', '/x/Proj', false)).not.toBe(cacheFileFor('/c', '/x/proj', false));
  });

  it('case-sensitive neighbours "Proj" and "proj" keep their own sessions; an old session is still read', async () => {
    const big = path.join(tmp, 'Proj');
    const small = path.join(tmp, 'proj');
    put(path.join(big, 'a.md'));
    put(path.join(small, 'b.md'));
    const cfg = path.join(tmp, 'cfg');
    // A session saved before the change, under the old (folded) id.
    put(path.join(cfg, 'sessions', `${rootId(big, true)}.json`), JSON.stringify({ openTabs: ['a.md'], activeTab: 'a.md' }));
    const s = svc(cfg);
    await s.openWorkspace(big);
    if (s.workspace!.foldsCase) return; // this disk folds case: one folder, one id (as before)
    expect((await s.getSession()).openTabs).toEqual(['a.md']);
    await s.saveSession({ openTabs: ['a.md', 'Big only'], activeTab: 'a.md' });
    const t = svc(cfg);
    await t.openWorkspace(small);
    expect((await t.getSession()).openTabs).not.toContain('Big only');
  });
});

describe('L2: settings values have a size cap', () => {
  it('an oversized value is refused before anything is applied or written', async () => {
    const cfg = path.join(tmp, 'cfg');
    const s = svc(cfg);
    const before = await s.getSettings();
    await expect(s.saveSettings({ excludeGlobs: ['x'.repeat(70 * 1024)] })).rejects.toMatchObject({ code: 'ETOOBIG' });
    expect((await s.getSettings()).excludeGlobs).toEqual(before.excludeGlobs);
    expect(fs.existsSync(path.join(cfg, 'settings.json')) ? fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8') : '').not.toContain('xxxxxxxx');
    expect((await s.saveSettings({ fontSize: 16 })).fontSize).toBe(16);
  });
});
