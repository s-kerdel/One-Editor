// Bookmarks storage (BackendService.bookmarks): one file per folder in One's app data, never in the folder;
// changes go through cleanOp and are applied to the file as it is on disk (desktop and browser mode share it).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackendService, rootId } from '../../../src/backend/service';

let tmp: string;
let root: string;
let cfg: string;
const open: BackendService[] = [];
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-bookmarks-'));
  root = path.join(tmp, 'notes');
  cfg = path.join(tmp, 'config');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  for (const f of ['a.md', 'b.md', 'sub/c.md']) await fsp.writeFile(path.join(root, f), f);
});
afterEach(async () => {
  for (const s of open.splice(0)) s.dispose();
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});
async function service(kind?: 'desktop' | 'web') {
  const s = new BackendService(cfg, kind ? { sessionKind: kind } : {});
  open.push(s);
  await s.openWorkspace(root);
  return s;
}
const file = () => path.join(cfg, 'bookmarks', `${rootId(open[0]?.workspace?.root ?? path.resolve(root))}.json`);

describe('bookmarks storage', () => {
  it('lives in app data (per folder), shared by desktop and browser mode; the folder stays untouched', async () => {
    const before = fs.readdirSync(root).sort();
    const desk = await service();
    expect(await desk.bookmarks()).toEqual([]);
    expect(await desk.bookmarks({ op: 'add', paths: ['a.md', 'sub'] })).toEqual([{ path: 'a.md' }, { path: 'sub' }]);
    const web = await service('web');
    expect(await web.bookmarks({ op: 'label', path: 'sub', label: 'Work' })).toEqual([{ path: 'a.md' }, { path: 'sub', label: 'Work' }]);
    // The desktop's next change starts from the file as it is now (the label is kept).
    expect(await desk.bookmarks({ op: 'move', paths: ['sub'], before: 'a.md' })).toEqual([{ path: 'sub', label: 'Work' }, { path: 'a.md' }]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, items: [{ path: 'sub', label: 'Work' }, { path: 'a.md' }] });
    expect(fs.readdirSync(root).sort()).toEqual(before);
  });

  it('follows a rename; a missing target stays until removed', async () => {
    const s = await service();
    await s.bookmarks({ op: 'add', paths: ['sub', 'sub/c.md', 'gone.md'] });
    expect(await s.bookmarks({ op: 'rename', from: 'sub', to: 'archive/sub' })).toEqual([{ path: 'archive/sub' }, { path: 'archive/sub/c.md' }, { path: 'gone.md' }]);
    expect(await s.bookmarks({ op: 'remove', paths: ['gone.md'] })).toEqual([{ path: 'archive/sub' }, { path: 'archive/sub/c.md' }]);
  });

  it('refuses bad changes (EINVAL) and works only with a folder open', async () => {
    const s = await service();
    for (const bad of [{ op: 'add', paths: ['../x'] }, { op: 'add', paths: ['/etc/passwd'] }, { op: 'nope' }, 'add', 7]) {
      await expect(s.bookmarks(bad as never)).rejects.toMatchObject({ code: 'EINVAL' });
    }
    expect(fs.existsSync(file())).toBe(false);
    const none = new BackendService(cfg);
    open.push(none);
    await expect(none.bookmarks()).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  it('a damaged file reads as its valid entries; overlapping changes are all kept', async () => {
    await fsp.mkdir(path.dirname(file()), { recursive: true });
    await fsp.writeFile(file(), JSON.stringify({ items: [{ path: 'a.md' }, { path: '..' }, 3] }));
    const s = await service();
    expect(await s.bookmarks()).toEqual([{ path: 'a.md' }]);
    await Promise.all(['b.md', 'sub', 'sub/c.md'].map((p) => s.bookmarks({ op: 'add', paths: [p] })));
    expect((await s.bookmarks()).map((b) => b.path).sort()).toEqual(['a.md', 'b.md', 'sub', 'sub/c.md']);
    await fsp.writeFile(file(), '{ not json');
    expect(await s.bookmarks()).toEqual([]);
  });
});
