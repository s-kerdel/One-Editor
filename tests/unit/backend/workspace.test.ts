import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { Workspace } from '../../../src/backend/workspace';
import { decode, encode } from '../../../src/backend/textcodec';
import { createExcludeMatcher } from '../../../src/backend/exclude';

let dir: string;
let ws: Workspace;
const p = (...s: string[]) => path.join(dir, ...s);
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-ws-'));
  await fsp.cp(path.resolve(__dirname, '../../fixtures/workspace'), dir, { recursive: true });
  ws = new Workspace(dir);
});
afterEach(async () => {
  ws.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('Workspace tree', () => {
  it('lists a sorted tree with dirs first', async () => {
    const tree = await ws.listTree();
    const names = tree.children!.map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['code', 'deep', 'notes']);
    expect(names).toContain('README.md');
  });

  it('hides excluded and hidden entries, honours globs and rooted paths', async () => {
    await fsp.mkdir(p('node_modules', 'x'), { recursive: true });
    await fsp.mkdir(p('docs', 'build'), { recursive: true });
    await fsp.writeFile(p('docs', 'keep.md'), '');
    await fsp.writeFile(p('debug.log'), '');
    await fsp.writeFile(p('.env'), 'X=1');
    ws.setOptions({ exclude: ['node_modules', '*.log', 'docs/build'], showHidden: false });
    const names = (await ws.listTree()).children!.map((c) => c.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('debug.log');
    expect(names).not.toContain('.env');
    const docs = (await ws.listTree('docs')).children!.map((c) => c.name);
    expect(docs).toEqual(['keep.md']);
    ws.setOptions({ exclude: [], showHidden: true });
    expect((await ws.listTree()).children!.map((c) => c.name)).toContain('.env');
  });

  it('lists a subtree on demand', async () => {
    const sub = await ws.listTree('deep');
    expect(sub.path).toBe('deep');
    expect(sub.children![0].children![0].children![0].path).toBe('deep/nested/folder/Deep note.md');
  });

  it('survives symlink loops and follows healthy links', async () => {
    try {
      fs.symlinkSync(dir, p('notes', 'loop'), 'dir');
      fs.symlinkSync(p('code'), p('code-link'), 'dir');
    } catch {
      return; // no symlink permission (Windows without dev mode)
    }
    const tree = await ws.listTree();
    const notes = tree.children!.find((c) => c.name === 'notes')!;
    const loop = notes.children!.find((c) => c.name === 'loop')!;
    expect(loop.symlink).toBe(true);
    expect(loop.children).toEqual([]); // not followed
    const link = tree.children!.find((c) => c.name === 'code-link')!;
    expect(link.children!.map((c) => c.name)).toContain('app.ts');
  });

  it('keeps paths inside the root', () => {
    expect(ws.abs('../etc/passwd').startsWith(dir)).toBe(true); // normalised to 'etc/passwd' inside root
    expect(ws.rel(path.join(dir, 'notes', 'a.md'))).toBe('notes/a.md');
    expect(ws.rel(path.dirname(dir))).toBeNull();
  });
});

describe('Workspace files', () => {
  it('preserves CRLF line endings on round-trip', async () => {
    const f = await ws.readFile('notes/windows-crlf.md');
    expect(f.eol).toBe('crlf');
    expect(f.content).not.toContain('\r');
    await ws.writeFile('notes/windows-crlf.md', f.content + 'Line three\n');
    const raw = await fsp.readFile(p('notes/windows-crlf.md'), 'utf8');
    expect(raw).toBe('Line one\r\nLine two with CRLF\r\nLine three\r\n');
  });

  it('preserves a UTF-8 BOM', async () => {
    await fsp.writeFile(p('bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\r\n')]));
    const f = await ws.readFile('bom.md');
    expect(f.bom).toBe(true);
    expect(f.content).toBe('héllo\n');
    await ws.writeFile('bom.md', 'héllo\nworld\n'); // no options: detected from disk
    const raw = await fsp.readFile(p('bom.md'));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.subarray(3).toString('utf8')).toBe('héllo\r\nworld\r\n');
  });

  it('round-trips UTF-16 LE (PowerShell) and Windows-1252 files byte-exactly', async () => {
    const u16 = encode('Grüße\r\n', 'utf16le', true);
    await fsp.writeFile(p('ps.txt'), u16);
    const f = await ws.readFile('ps.txt');
    expect(f.encoding).toBe('utf16le');
    expect(f.content).toBe('Grüße\n');
    await ws.writeFile('ps.txt', f.content, { eol: f.eol, bom: f.bom, encoding: f.encoding });
    expect(Buffer.compare(await fsp.readFile(p('ps.txt')), u16)).toBe(0);

    const ansi = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94, 0x20, 0x80]); // café “q” €
    await fsp.writeFile(p('ansi.txt'), ansi);
    const g = await ws.readFile('ansi.txt');
    expect(g.encoding).toBe('windows-1252');
    expect(g.content).toBe('café “q” €');
    await ws.writeFile('ansi.txt', g.content, { encoding: g.encoding });
    expect(Buffer.compare(await fsp.readFile(p('ansi.txt')), ansi)).toBe(0);
  });

  it('flags binary files instead of decoding them', async () => {
    await fsp.writeFile(p('img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
    const f = await ws.readFile('img.png');
    expect(f.binary).toBe(true);
    expect(f.content).toBe('');
    expect(decode(Buffer.from('plain')).binary).toBe(false);
  });

  it('detects external changes via expectedMtime', async () => {
    const f = await ws.readFile('README.md');
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(p('README.md'), 'changed elsewhere');
    await expect(ws.writeFile('README.md', 'mine', { expectedMtime: f.mtime })).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  });

  it('saves atomically without leaving temp files, keeping file mode', async () => {
    if (process.platform !== 'win32') await fsp.chmod(p('README.md'), 0o640);
    await ws.writeFile('README.md', 'new content');
    expect(await fsp.readFile(p('README.md'), 'utf8')).toBe('new content');
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
    if (process.platform !== 'win32') expect((await fsp.stat(p('README.md'))).mode & 0o777).toBe(0o640);
  });

  it('writes through symlinks and keeps hard links intact', async () => {
    try {
      fs.symlinkSync(p('README.md'), p('link.md'));
      fs.linkSync(p('notes', 'kubernetes.md'), p('hard.md'));
    } catch {
      return;
    }
    await ws.writeFile('link.md', 'via link');
    expect(fs.lstatSync(p('link.md')).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(p('README.md'), 'utf8')).toBe('via link');
    await ws.writeFile('hard.md', 'via hard link');
    expect(await fsp.readFile(p('notes', 'kubernetes.md'), 'utf8')).toBe('via hard link');
  });

  it('refuses to write read-only files', async () => {
    if (process.platform !== 'win32' && process.getuid?.() === 0) return; // root ignores permissions
    await fsp.chmod(p('README.md'), 0o444);
    await expect(ws.writeFile('README.md', 'x')).rejects.toMatchObject({ code: 'EACCES' });
    await fsp.chmod(p('README.md'), 0o644);
  });

  it('creates files and folders, refusing to clobber', async () => {
    await ws.createFile('new/dir/note.md', 'hi');
    expect(await fsp.readFile(p('new/dir/note.md'), 'utf8')).toBe('hi');
    await expect(ws.createFile('new/dir/note.md')).rejects.toMatchObject({ code: 'EEXIST' });
    await ws.createDir('folder');
    await expect(ws.createDir('folder')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('renames: case-only, clash, into-itself, missing parent', async () => {
    await ws.rename('notes/kubernetes.md', 'notes/Kubernetes.md');
    expect(fs.readdirSync(p('notes'))).toContain('Kubernetes.md');
    expect(fs.readdirSync(p('notes'))).not.toContain('kubernetes.md');
    await expect(ws.rename('README.md', 'notes/Daily notes.md')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(ws.rename('deep', 'deep/nested/deeper')).rejects.toMatchObject({ code: 'EINVAL' });
    await ws.rename('code/app.ts', 'archive/2024/app.ts');
    expect(fs.existsSync(p('archive/2024/app.ts'))).toBe(true);
    await expect(ws.rename('nope.md', 'x.md')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes via the trash callback, refusing the root', async () => {
    const trashed: string[] = [];
    await ws.remove('notes', async (abs) => {
      trashed.push(abs);
      await fsp.rm(abs, { recursive: true });
    });
    expect(trashed).toEqual([p('notes')]);
    await expect(ws.remove('')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
  });

  it('reads all text files for indexing', async () => {
    const all = await ws.readAllText();
    const paths = all.map((f) => f.path);
    expect(paths).toContain('code/UserController.php');
    expect(paths).toContain('deep/nested/folder/Deep note.md');
  });
});

describe('exclude matcher', () => {
  it('matches names, globs and rooted paths case-insensitively', () => {
    const m = createExcludeMatcher(['node_modules', '*.log', 'docs/build'], false);
    expect(m.path('a/node_modules/b')).toBe(true);
    expect(m.path('a/Node_Modules')).toBe(true);
    expect(m.path('x/err.LOG')).toBe(true);
    expect(m.path('docs/build/x.md')).toBe(true);
    expect(m.path('other/docs/build')).toBe(false);
    expect(m.path('.git/config')).toBe(true); // hidden
    expect(m.path('notes/a.md')).toBe(false);
  });
});
