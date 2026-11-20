// A folder someone else made (a clone, an unpacked archive) can hold symlinks / junctions. Nothing the
// app does in that folder may reach through one to a place outside it: not the tree, not the index,
// not a read, write, create, rename or delete. Links that stay inside the folder keep working.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../../src/backend/workspace';
import { BackendService } from '../../../src/backend/service';
import type { TreeNode } from '../../../src/shared/api';

const BASE = path.resolve(__dirname, '../../../.tmp/sec-desktop/unit-links');
let tmp: string;
let root: string;
let outside: string;
let ws: Workspace;
let canLink = true;

const flat = (n: TreeNode, out: string[] = []): string[] => {
  for (const c of n.children ?? []) {
    out.push(c.path);
    flat(c, out);
  }
  return out;
};
const refused = { code: 'OUTSIDE_WORKSPACE' };

beforeEach(async () => {
  await fsp.mkdir(BASE, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(BASE, 't-'));
  root = path.join(tmp, 'ws');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'notes', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'a.md'), '# A inside\n');
  fs.writeFileSync(path.join(root, 'notes', 'deep', 'b.md'), '# B inside\n');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'TOP SECRET\n');
  fs.writeFileSync(path.join(outside, 'sub', 'more.md'), 'MORE SECRET\n');
  try {
    fs.symlinkSync(outside, path.join(root, 'out-dir'), 'dir'); // folder link → outside
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'out-file.md')); // file link → outside
    fs.symlinkSync(path.join('..', '..', 'outside'), path.join(root, 'notes', 'rel-out'), 'dir'); // relative, nested
    fs.symlinkSync(path.join(root, 'notes', 'deep'), path.join(root, 'in-dir'), 'dir'); // folder link → inside
    fs.symlinkSync(path.join(root, 'notes', 'a.md'), path.join(root, 'in-file.md')); // file link → inside
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(root, 'dangling.md')); // target missing (outside)
  } catch {
    canLink = false; // no symlink permission (Windows without developer mode)
  }
  ws = new Workspace(root);
});
afterEach(async () => {
  ws.dispose();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('links that point outside the folder', () => {
  it('are neither listed nor followed; links inside the folder are', async () => {
    if (!canLink) return;
    const paths = flat(await ws.listTree());
    expect(paths.sort()).toEqual(['in-dir', 'in-dir/b.md', 'in-file.md', 'notes', 'notes/a.md', 'notes/deep', 'notes/deep/b.md']);
    expect(ws.filePaths().sort()).toEqual(['in-dir/b.md', 'in-file.md', 'notes/a.md', 'notes/deep/b.md']);
    await expect(ws.listTree('out-dir')).rejects.toMatchObject(refused);
    await expect(ws.listTree('notes/rel-out/sub')).rejects.toMatchObject(refused);
    expect(flat(await ws.listTree('in-dir'))).toEqual(['in-dir/b.md']);
  });

  it('the index never gets their text — not in a full pass, not when asked for a path by name', async () => {
    if (!canLink) return;
    const all = await ws.readAllText();
    expect(all.map((f) => f.path).sort()).toEqual(['in-dir/b.md', 'in-file.md', 'notes/a.md', 'notes/deep/b.md']);
    expect(JSON.stringify(all)).not.toContain('SECRET');
    const some = await ws.readIndexedFiles(['out-dir/secret.md', 'out-file.md', 'notes/rel-out/sub/more.md', 'notes/a.md', 'in-dir/b.md']);
    expect(some.files.map((f) => f.path).sort()).toEqual(['in-dir/b.md', 'notes/a.md']);
    expect(some.gone.sort()).toEqual(['notes/rel-out/sub/more.md', 'out-dir/secret.md', 'out-file.md']);
    const raw = JSON.parse(Buffer.from(await ws.readIndexedFilesRaw(['out-dir/secret.md', 'notes/a.md'])).toString('utf8'));
    expect(raw.files.map((f: { path: string }) => f.path)).toEqual(['notes/a.md']);
    expect(raw.gone).toEqual(['out-dir/secret.md']);
    expect(JSON.stringify(raw)).not.toContain('SECRET');
    // A file the watcher has not reported yet is still served (it is really in the folder).
    fs.writeFileSync(path.join(root, 'notes', 'fresh.md'), 'fresh\n');
    expect((await ws.readIndexedFiles(['notes/fresh.md'])).files.map((f) => f.path)).toEqual(['notes/fresh.md']);
  });

  it('cannot be read through', async () => {
    if (!canLink) return;
    for (const p of ['out-file.md', 'out-dir/secret.md', 'out-dir/sub/more.md', 'notes/rel-out/secret.md']) await expect(ws.readFile(p), p).rejects.toMatchObject(refused);
    expect((await ws.readFile('in-file.md')).content).toBe('# A inside\n');
    expect((await ws.readFile('in-dir/b.md')).content).toBe('# B inside\n');
    await expect(ws.real('out-dir/secret.md')).rejects.toMatchObject(refused);
    expect(await ws.real('notes/a.md')).toBe(path.join(root, 'notes', 'a.md'));
  });

  it('cannot be written, created or made a folder through', async () => {
    if (!canLink) return;
    await expect(ws.writeFile('out-file.md', 'OVERWRITTEN\n')).rejects.toMatchObject(refused);
    await expect(ws.writeFile('out-dir/secret.md', 'OVERWRITTEN\n')).rejects.toMatchObject(refused);
    await expect(ws.writeFile('out-dir/new.md', 'x')).rejects.toMatchObject(refused);
    await expect(ws.writeBinary('out-dir/img.png', new Uint8Array([1, 2, 3]))).rejects.toMatchObject(refused);
    await expect(ws.createFile('out-dir/sub/new.md', 'x')).rejects.toMatchObject(refused);
    await expect(ws.createFile('notes/rel-out/a/b/c.md', 'x')).rejects.toMatchObject(refused);
    await expect(ws.createDir('out-dir/made')).rejects.toMatchObject(refused);
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('TOP SECRET\n');
    expect(fs.readdirSync(outside).sort()).toEqual(['secret.md', 'sub']);
    expect(fs.readdirSync(path.join(outside, 'sub'))).toEqual(['more.md']);
    // Inside the folder: writing through a link still edits its target and keeps the link.
    await ws.writeFile('in-file.md', '# A edited\n');
    expect(fs.readFileSync(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A edited\n');
    expect(fs.lstatSync(path.join(root, 'in-file.md')).isSymbolicLink()).toBe(true);
    await ws.createFile('in-dir/new.md', 'n');
    expect(fs.existsSync(path.join(root, 'notes', 'deep', 'new.md'))).toBe(true);
    // A dangling link is replaced by a real file in the folder; nothing appears at its old target.
    await ws.writeFile('dangling.md', 'now a file\n');
    expect(fs.lstatSync(path.join(root, 'dangling.md')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'nowhere'))).toBe(false);
  });

  it('cannot be renamed or deleted through; the link itself can be removed (its target stays)', async () => {
    if (!canLink) return;
    await expect(ws.remove('out-dir/secret.md')).rejects.toMatchObject(refused);
    await expect(ws.remove('out-dir/sub')).rejects.toMatchObject(refused);
    await expect(ws.rename('out-dir/secret.md', 'stolen.md')).rejects.toMatchObject(refused);
    await expect(ws.rename('notes/a.md', 'out-dir/planted.md')).rejects.toMatchObject(refused);
    await expect(ws.rename('notes/a.md', 'notes/rel-out/sub/planted.md')).rejects.toMatchObject(refused);
    expect(fs.readdirSync(outside).sort()).toEqual(['secret.md', 'sub']);
    expect(fs.existsSync(path.join(root, 'notes', 'a.md'))).toBe(true);
    await ws.rename('out-file.md', 'renamed-link.md'); // moves the link, not the file behind it
    expect(fs.lstatSync(path.join(root, 'renamed-link.md')).isSymbolicLink()).toBe(true);
    await ws.remove('renamed-link.md');
    await ws.remove('out-dir');
    expect(fs.existsSync(path.join(root, 'out-dir'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('TOP SECRET\n');
    expect(fs.readdirSync(path.join(outside, 'sub'))).toEqual(['more.md']);
  });

  it('a link that appears later is not picked up by the watcher either', async () => {
    if (!canLink) return;
    await ws.listTree();
    const events: string[] = [];
    ws.onEvents((e) => events.push(...e.map((x) => `${x.type}:${x.path}`)));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'notes', 'late.md'));
    fs.symlinkSync(outside, path.join(root, 'notes', 'late-dir'), 'dir');
    fs.symlinkSync(path.join(root, 'notes', 'a.md'), path.join(root, 'notes', 'late-in.md'));
    for (const p of ['notes/late.md', 'notes/late-dir', 'notes/late-in.md']) (ws as unknown as { queue(p: string): void }).queue(p);
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual(['add:notes/late-in.md']);
    expect(ws.filePaths()).not.toContain('notes/late.md');
  });

  it('a workspace that IS a link works as before (its real location is the root)', async () => {
    if (!canLink) return;
    const alias = path.join(tmp, 'alias');
    fs.symlinkSync(root, alias, 'dir');
    const w = new Workspace(alias);
    try {
      expect(flat(await w.listTree())).toContain('notes/a.md');
      expect((await w.readFile('notes/a.md')).content).toBe('# A inside\n');
      await w.writeFile('notes/new.md', 'ok\n');
      await expect(w.readFile('out-dir/secret.md')).rejects.toMatchObject(refused);
    } finally {
      w.dispose();
    }
  });

  it('BackendService: reveal in file manager and the RPC surface refuse the same way', async () => {
    if (!canLink) return;
    const revealed: string[] = [];
    const svc = new BackendService(path.join(tmp, 'cfg'), { revealInFolder: (abs) => void revealed.push(abs) }, { cacheDir: '' });
    try {
      await svc.openWorkspace(root);
      await expect(svc.readFile('out-dir/secret.md')).rejects.toMatchObject(refused);
      await expect(svc.writeFile('out-file.md', 'x')).rejects.toMatchObject(refused);
      await expect(svc.remove('out-dir/secret.md', { permanent: true })).rejects.toMatchObject(refused);
      await expect(svc.revealInFolder('out-dir/secret.md')).rejects.toMatchObject(refused);
      await svc.revealInFolder('out-file.md'); // the link itself, in its (real) folder
      await svc.revealInFolder('notes/a.md');
      expect(revealed).toEqual([path.join(root, 'out-file.md'), path.join(root, 'notes', 'a.md')]);
      expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('TOP SECRET\n');
    } finally {
      svc.dispose();
    }
  });
});
