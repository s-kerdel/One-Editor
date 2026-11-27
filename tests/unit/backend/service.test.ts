import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackendService } from '../../../src/backend/service';
import { xdgTrash } from '../../../src/backend/trash';

let tmp: string;
let root: string;
let cfg: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-svc-'));
  root = path.join(tmp, 'notes');
  cfg = path.join(tmp, 'config');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'a.md'), 'A');
  await fsp.writeFile(path.join(root, 'sub', 'b.md'), 'B');
});
afterEach(async () => {
  delete process.env.SEC_EDIT_TRASH_DIR;
  // Retries: fire-and-forget writes (recent folders) may still land while the dir is being removed.
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('BackendService', () => {
  it('persists settings across instances and survives concurrent saves', async () => {
    const s1 = new BackendService(cfg);
    await Promise.all([s1.saveSettings({ theme: 'light' }), s1.saveSettings({ fontSize: 18 }), s1.saveSettings({ lineNumbers: true })]);
    const s2 = new BackendService(cfg);
    const got = await s2.getSettings();
    expect(got).toMatchObject({ theme: 'light', fontSize: 18, lineNumbers: true, autosave: true });
    expect(fs.readdirSync(cfg).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('notifies settings listeners with the patch', async () => {
    const s = new BackendService(cfg);
    const seen: unknown[] = [];
    s.onSettingsChanged((_all, patch) => seen.push(patch));
    await s.saveSettings({ theme: 'system' });
    expect(seen).toEqual([{ theme: 'system' }]);
  });

  it('keeps a session per workspace', async () => {
    const s = new BackendService(cfg);
    await s.openWorkspace(root);
    await s.saveSession({ openTabs: ['a.md'], activeTab: 'a.md', sidebarWidth: 300, expanded: ['sub'] });
    await s.openWorkspace(path.join(root, 'sub'));
    expect((await s.getSession()).openTabs).toEqual([]);
    await s.openWorkspace(root);
    expect(await s.getSession()).toMatchObject({ openTabs: ['a.md'], sidebarWidth: 300, expanded: ['sub'] });
    s.dispose();
  });

  it('tracks recent folders (deduped, most recent first) and can forget them', async () => {
    const s = new BackendService(cfg);
    await s.openWorkspace(path.join(root, 'sub'));
    await s.openWorkspace(root);
    await s.openWorkspace(path.join(root, 'sub'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.recentWorkspaces()).toEqual([path.join(root, 'sub'), root]);
    expect(await s.forgetRecent(root)).toEqual([path.join(root, 'sub')]);
    s.dispose();
  });

  it('two windows (services) on one app data folder keep each other’s recent folders: newest first, deduped, capped', async () => {
    const other = path.join(tmp, 'other');
    await fsp.mkdir(other);
    const sub = path.join(root, 'sub');
    const onDisk = () => (fs.existsSync(path.join(cfg, 'recent.json')) ? JSON.parse(fs.readFileSync(path.join(cfg, 'recent.json'), 'utf8')) : []);
    const a = new BackendService(cfg);
    const b = new BackendService(cfg);
    // At the same time: neither write drops the other's folder (each was a whole stale copy before).
    await Promise.all([a.openWorkspace(root), b.openWorkspace(other)]);
    await expect.poll(() => onDisk().slice().sort()).toEqual([other, root].sort());
    // Each sees what the other added (the file changed since it last read it).
    expect((await a.recentWorkspaces()).sort()).toEqual([other, root].sort());
    expect((await b.recentWorkspaces()).sort()).toEqual([other, root].sort());
    // The newest open goes first everywhere; a folder already listed moves up instead of twice.
    await a.openWorkspace(sub);
    await expect.poll(async () => (await b.recentWorkspaces())[0]).toBe(sub);
    await b.openWorkspace(root);
    await expect.poll(() => a.recentWorkspaces()).toEqual([root, sub, other]);
    expect(await b.forgetRecent(sub)).toEqual([root, other]);
    expect(await a.recentWorkspaces()).toEqual([root, other]);
    // A list another writer left long: the merge keeps it at 20, the newest first.
    fs.writeFileSync(path.join(cfg, 'recent.json'), JSON.stringify(Array.from({ length: 25 }, (_, i) => `/gone/${i}`)));
    await a.openWorkspace(other);
    await expect.poll(() => onDisk().length).toBe(20);
    expect(onDisk()[0]).toBe(other);
    expect(await b.recentWorkspaces()).toEqual(onDisk());
    a.dispose();
    b.dispose();
  });

  it('bootstrap returns everything for first paint and drains open requests', async () => {
    const s = new BackendService(cfg);
    await s.openWorkspace(root);
    s.openRequests.push(path.join(root, 'a.md'));
    const b = await s.bootstrap();
    expect(b.workspace?.root).toBe(root);
    expect(b.settings.theme).toBeDefined();
    expect(b.openRequests).toEqual([path.join(root, 'a.md')]);
    expect((await s.bootstrap()).openRequests).toEqual([]);
    s.dispose();
  });

  it('resolves absolute paths to workspace-relative ones', async () => {
    const s = new BackendService(cfg);
    await s.openWorkspace(root);
    expect(await s.resolvePath(path.join(root, 'sub', 'b.md'))).toEqual({ abs: path.join(root, 'sub', 'b.md'), kind: 'file', rel: 'sub/b.md' });
    expect(await s.resolvePath(root)).toMatchObject({ kind: 'dir', rel: '' });
    expect(await s.resolvePath(tmp)).toMatchObject({ kind: 'dir', rel: null });
    expect(await s.resolvePath(path.join(root, 'missing.md'))).toBeNull();
    s.dispose();
  });

  it('removes through the trash hook, falls back to the platform trash, else ETRASH', async () => {
    const hooked: string[] = [];
    const s = new BackendService(cfg, {
      trash: async (abs) => {
        hooked.push(abs);
        await fsp.rm(abs);
      },
    });
    await s.openWorkspace(root);
    await s.remove('a.md');
    expect(hooked).toEqual([path.join(root, 'a.md')]);

    // Hook fails → platform trash (test hook dir)
    process.env.SEC_EDIT_TRASH_DIR = path.join(tmp, 'trash');
    const s2 = new BackendService(cfg, { trash: async () => Promise.reject(new Error('no dbus')) });
    await s2.openWorkspace(root);
    await s2.remove('sub');
    expect(fs.existsSync(path.join(tmp, 'trash', 'sub', 'b.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'sub'))).toBe(false);

    // Permanent delete skips the trash entirely.
    await fsp.writeFile(path.join(root, 'c.md'), 'C');
    await s2.remove('c.md', { permanent: true });
    expect(fs.existsSync(path.join(root, 'c.md'))).toBe(false);
    s.dispose();
    s2.dispose();
  });

  it('implements the freedesktop trash spec', async () => {
    const data = path.join(tmp, 'xdg');
    await fsp.writeFile(path.join(root, 'gone.md'), 'bye');
    await xdgTrash(path.join(root, 'gone.md'), data);
    await fsp.writeFile(path.join(root, 'gone.md'), 'again');
    await xdgTrash(path.join(root, 'gone.md'), data);
    expect(fs.readdirSync(path.join(data, 'Trash', 'files')).sort()).toEqual(['gone.md', 'gone.md.2']);
    const info = await fsp.readFile(path.join(data, 'Trash', 'info', 'gone.md.trashinfo'), 'utf8');
    expect(info).toMatch(/^\[Trash Info\]\nPath=.*gone\.md\nDeletionDate=\d{4}-\d\d-\d\dT/);
  });
});
