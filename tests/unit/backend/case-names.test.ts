// Names that differ only in case, per FOLDER (not per OS). We have no Windows CI, so both Windows cases
// run here: (a) win32 + a case-sensitive WSL root (\\wsl.localhost\… is ext4 behind 9P: "Note.md" and
// "note.md" are two files) and (b) a case-insensitive NTFS root, emulated by a node:fs/promises shim
// that resolves every name case-insensitively like NTFS does (lookups fold, listings keep the stored case).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FsEvent } from '../../../src/shared/api';

const ntfs = vi.hoisted(() => ({ root: '' })); // paths under `root` behave like NTFS

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const nfs = await import('node:fs');
  const np = await import('node:path');
  const fold = (p: unknown): any => {
    if (typeof p !== 'string' || !ntfs.root || !(p === ntfs.root || p.startsWith(ntfs.root + np.sep))) return p;
    let cur = ntfs.root;
    for (const seg of p.slice(ntfs.root.length).split(np.sep).filter(Boolean)) {
      const exact = np.join(cur, seg);
      let next = exact;
      if (!nfs.existsSync(exact)) {
        let names: string[] = [];
        try {
          names = nfs.readdirSync(cur);
        } catch {}
        const hit = names.find((n) => n.toLowerCase() === seg.toLowerCase());
        if (hit) next = np.join(cur, hit);
      }
      cur = next;
    }
    return cur;
  };
  const one = (fn: (...a: any[]) => any) => (p: unknown, ...rest: unknown[]) => fn(fold(p), ...rest);
  const shim = {
    ...real,
    stat: one(real.stat),
    lstat: one(real.lstat),
    readFile: one(real.readFile),
    writeFile: one(real.writeFile),
    readdir: one(real.readdir),
    opendir: one(real.opendir),
    open: one(real.open),
    mkdir: one(real.mkdir),
    rm: one(real.rm),
    chmod: one(real.chmod),
    realpath: one(real.realpath),
    // NTFS: a rename onto another spelling of an existing name replaces that entry and takes the new spelling.
    rename: async (a: string, b: string) => {
      const fa = fold(a);
      const fb = fold(b);
      const dst = np.join(np.dirname(fb), np.basename(b));
      if (fb !== dst && nfs.existsSync(fb) && fb !== fa) await real.rm(fb, { recursive: true, force: true });
      return real.rename(fa, dst);
    },
    cp: (a: string, b: string, o?: any) => real.cp(fold(a), fold(b), o),
  };
  return { ...shim, default: shim };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.resolve(__dirname, '../../../.tmp/unit-case-names');
const realPlatform = process.platform;
const waitFor = async (pred: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const ls = (...p: string[]) => fs.readdirSync(path.join(dir, ...p)).sort();

let dir: string;
type WsModule = typeof import('../../../src/backend/workspace');
/** Imports the workspace module as if running on `platform` (it reads process.platform at load). */
async function load(platform: NodeJS.Platform): Promise<WsModule> {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();
  return import('../../../src/backend/workspace');
}

beforeEach(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
  fs.writeFileSync(path.join(dir, 'Note.md'), 'upper\n');
  fs.mkdirSync(path.join(dir, 'Docs'));
  fs.writeFileSync(path.join(dir, 'Docs', 'a.md'), 'a\n');
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  ntfs.root = '';
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('probeCaseSensitive (per folder, never writes)', () => {
  it('case-sensitive folder → true; NTFS-like folder → false; nothing to try → null', async () => {
    const { probeCaseSensitive } = await load(realPlatform);
    expect(await probeCaseSensitive(dir)).toBe(true);
    ntfs.root = dir;
    expect(await probeCaseSensitive(dir)).toBe(false);
    ntfs.root = '';
    const bare = path.join(dir, '1234');
    fs.mkdirSync(bare);
    expect(await probeCaseSensitive(bare)).toBe(null); // no letters in its name, no children
    fs.writeFileSync(path.join(bare, 'x.md'), '');
    expect(await probeCaseSensitive(bare)).toBe(true);
    expect(ls(), 'the probe created nothing').toEqual(['1234', 'Docs', 'Note.md']);
    expect(ls('1234')).toEqual(['x.md']);
  });
});

describe('(a) win32 + case-sensitive WSL root', () => {
  it('both spellings live side by side; delete / move touch exactly the one named', async () => {
    const { Workspace } = await load('win32');
    const ws = new Workspace(dir, { watchMode: 'perdir', debounceMs: 20, readThreads: 0 });
    expect(ws.info().caseSensitive, 'until probed: the platform guess').toBe(false);
    await ws.listTree();
    expect(await ws.detectCase(), 'probed, not guessed from process.platform').toBe(true);
    expect(ws.info().caseSensitive).toBe(true);
    await ws.createFile('note.md', 'lower\n');
    await ws.createDir('docs');
    await ws.createFile('docs/b.md', 'b\n');
    expect(ls()).toEqual(['Docs', 'Note.md', 'docs', 'note.md']);
    // "Cannot move a folder into itself" used to fold case on win32: docs/ is not inside Docs/.
    await ws.rename('docs', 'Docs/docs');
    expect(ls('Docs')).toEqual(['a.md', 'docs']);
    await ws.rename('Docs/docs', 'docs');
    await ws.remove('note.md');
    expect(ls()).toEqual(['Docs', 'Note.md', 'docs']);
    expect(fs.readFileSync(path.join(dir, 'Note.md'), 'utf8')).toBe('upper\n');
    expect(ws.filePaths().sort()).toEqual(['Docs/a.md', 'Note.md', 'docs/b.md']);
    await ws.remove('docs');
    expect(ls()).toEqual(['Docs', 'Note.md']);
    expect(ws.filePaths().sort()).toEqual(['Docs/a.md', 'Note.md']);
    ws.dispose();
  });

  it('.gitignore matches case-sensitively there (as git does: core.ignorecase=false)', async () => {
    const { Workspace } = await load('win32');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Build/\n');
    fs.mkdirSync(path.join(dir, 'Build'));
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'Build', 'out.md'), 'generated\n');
    fs.writeFileSync(path.join(dir, 'build', 'notes.md'), 'mine\n');
    const ws = new Workspace(dir, { watchMode: 'poll', readThreads: 0 });
    const paths = (await ws.readAllText()).map((f) => f.path);
    expect(paths).toContain('build/notes.md');
    expect(paths).not.toContain('Build/out.md');
    ws.dispose();
  });
});

describe('(b) case-insensitive NTFS root', () => {
  beforeEach(() => {
    ntfs.root = dir;
  });

  it('creating / writing another spelling is refused with a clear message, never opens or overwrites the other file', async () => {
    const { Workspace } = await load('win32');
    const ws = new Workspace(dir, { watchMode: 'poll', readThreads: 0 });
    await ws.listTree();
    expect(ws.info().caseSensitive).toBe(false);
    await expect(ws.createFile('note.md', 'lower\n')).rejects.toMatchObject({ code: 'ECASE', message: expect.stringMatching(/“Note\.md” already exists .*only in case/) });
    await expect(ws.createDir('docs')).rejects.toMatchObject({ code: 'ECASE', message: expect.stringMatching(/“Docs”.*only in case/) });
    await expect(ws.createFile('docs/new.md')).rejects.toMatchObject({ code: 'ECASE' }); // would land in Docs/ and leave a phantom docs/
    await expect(ws.writeFile('note.md', 'clobber\n')).rejects.toMatchObject({ code: 'ECASE' });
    await expect(ws.writeBinary('NOTE.md', new Uint8Array([1]))).rejects.toMatchObject({ code: 'ECASE' });
    await expect(ws.readFile('note.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(ws.rename('Docs/a.md', 'note.md')).rejects.toMatchObject({ code: 'ECASE', message: expect.stringMatching(/only in case/) });
    expect(ls()).toEqual(['Docs', 'Note.md']);
    expect(ls('Docs')).toEqual(['a.md']);
    expect(fs.readFileSync(path.join(dir, 'Note.md'), 'utf8')).toBe('upper\n');
    expect(ws.filePaths().sort()).toEqual(['Docs/a.md', 'Note.md']);
    // The exact spelling still works normally.
    await ws.writeFile('Note.md', 'edited\n');
    expect((await ws.readFile('Note.md')).content).toBe('edited\n');
    ws.dispose();
  });

  it('a case-only rename leaves no phantom twin, and the stale spelling cannot delete the file', async () => {
    const { Workspace } = await load('win32');
    const ws = new Workspace(dir, { watchMode: 'perdir', debounceMs: 20, readThreads: 0 });
    const events: FsEvent[] = [];
    ws.onEvents((e) => events.push(...e));
    await ws.listTree();
    await ws.rename('Note.md', 'note.md');
    await ws.rename('Docs', 'docs');
    expect(ls()).toEqual(['docs', 'note.md']);
    await new Promise((r) => setTimeout(r, 300)); // the watcher reports the old names too
    await ws.settle();
    // Before the fix the old spelling stat'ed fine (NTFS finds the new one) → "add Note.md": two rows for
    // one file, and deleting either deleted the file → both rows gone.
    expect(events.filter((e) => e.type === 'add' || e.type === 'addDir').map((e) => e.path)).toEqual([]);
    expect(ws.filePaths().sort()).toEqual(['docs/a.md', 'note.md']);
    await expect(ws.remove('Note.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(ws.remove('Docs')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ls()).toEqual(['docs', 'note.md']);
    await ws.remove('note.md');
    expect(ls()).toEqual(['docs']);
    ws.dispose();
  });

  it('an external case-only rename (Explorer, git, a terminal) swaps the entry instead of adding a twin', async () => {
    const { Workspace } = await load('win32');
    const ws = new Workspace(dir, { watchMode: 'perdir', debounceMs: 20, readThreads: 0 });
    const events: string[] = [];
    ws.onEvents((e) => events.push(...e.map((x) => `${x.type}:${x.path}`)));
    await ws.listTree();
    await new Promise((r) => setTimeout(r, 50));
    fs.renameSync(path.join(dir, 'Note.md'), path.join(dir, 'note.md'));
    await waitFor(() => events.includes('add:note.md'));
    await ws.settle();
    expect(events).toContain('unlink:Note.md');
    expect(ws.filePaths().sort()).toEqual(['Docs/a.md', 'note.md']);
    ws.dispose();
  });
});
