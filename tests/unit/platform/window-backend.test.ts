// The window-backend seam, in-process implementation: forwards to a real BackendService and keeps its cached
// values (root, foldsCase, booted) current; everything async; nothing after dispose.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendService } from '../../../src/backend/service';
import { createInProcessBackend, type WindowBackend } from '../../../src/main/window-backend';

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.tmp/unit-wp2');
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e?.code);

let tmp: string;
let root: string;
let service: BackendService;
let b: WindowBackend;
beforeEach(async () => {
  await fsp.mkdir(BASE, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(BASE, 'wb-'));
  root = path.join(tmp, 'notes');
  const cfg = path.join(tmp, 'config');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.mkdir(cfg, { recursive: true });
  await fsp.writeFile(path.join(root, 'a.md'), 'A');
  // No indexer thread at open: these tests never search.
  await fsp.writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ 'search.indexing': 'onDemand' }));
  service = new BackendService(cfg, {}, { cacheDir: '' });
  b = createInProcessBackend(service);
});
afterEach(async () => {
  await b.dispose();
  // Retries: fire-and-forget writes (recent folders) may still land while the dir is being removed.
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('createInProcessBackend', () => {
  it('keeps root and foldsCase current after every open, main- or renderer-initiated', async () => {
    expect([b.root, b.foldsCase]).toEqual([null, false]);
    await b.openWorkspace(root);
    expect(b.root).toBe(root);
    expect(b.foldsCase).toBe(service.workspace!.foldsCase);
    const info = await b.call('openWorkspace', [path.join(root, 'sub')]);
    expect(info).toMatchObject({ root: path.join(root, 'sub'), name: 'sub' });
    expect(b.root).toBe(path.join(root, 'sub'));
    // A failed open leaves the folder (and the cached root) as it was.
    expect(await code(b.call('openWorkspace', [path.join(root, 'a.md')]))).toBe('ENOENT');
    expect(await code(b.openWorkspace(path.join(tmp, 'missing')))).toBe('ENOENT');
    expect(b.root).toBe(path.join(root, 'sub'));
  });

  it('booted flips with bootstrap(), which hands over the queued open requests', async () => {
    await b.openWorkspace(root);
    b.queueOpenRequest(path.join(root, 'a.md'));
    expect(b.booted).toBe(false);
    const boot = (await b.call('bootstrap', [])) as { openRequests: string[]; workspace: { root: string } };
    expect(b.booted).toBe(true);
    expect(boot.openRequests).toEqual([path.join(root, 'a.md')]);
    expect(boot.workspace.root).toBe(root);
    // JSON across the seam: a structured-clone / JSON round trip loses nothing.
    expect(JSON.parse(JSON.stringify(boot))).toEqual(boot);
  });

  it('forwards RPC calls; undefined becomes null; unknown methods are refused', async () => {
    await b.openWorkspace(root);
    expect(await b.call('readFile', ['a.md'])).toMatchObject({ content: 'A' });
    expect(await b.call('saveSession', [{ openTabs: [], activeTab: null }])).toBeNull();
    expect(await code(b.call('nope' as never, []))).toBe('EINVAL');
    expect(await b.recentWorkspaces()).toEqual([root]);
  });

  it.skipIf(process.platform === 'win32')('real(): containment through the workspace; refused with no folder or outside it', async () => {
    expect(await code(b.real('a.md'))).toBe('NO_WORKSPACE');
    await b.openWorkspace(root);
    expect(await b.real('a.md')).toBe(await fsp.realpath(path.join(root, 'a.md')));
    // ".." stays inside (lexically clamped); a link out of the folder is refused.
    expect(path.relative(root, await b.real('../elsewhere/x.md')).startsWith('..')).toBe(false);
    await fsp.mkdir(path.join(tmp, 'elsewhere'));
    await fsp.symlink(path.join(tmp, 'elsewhere'), path.join(root, 'out'));
    expect(await code(b.real('out/x.md'))).toBe('OUTSIDE_WORKSPACE');
  });

  it('index channel and git: always a promise, never a synchronous throw', async () => {
    let page!: Promise<unknown>;
    expect(() => (page = b.indexPage(null))).not.toThrow();
    expect(await code(page)).toBe('NO_WORKSPACE');
    expect(await b.gitNumstat()).toBeNull(); // the service refuses (no folder): null, not a rejection
    await b.openWorkspace(root);
    let files!: Promise<unknown>;
    expect(() => (files = b.indexFiles('not an array'))).not.toThrow(); // the service throws this one synchronously
    expect(await code(files)).toBe('EINVAL');
  });

  it('events: typed listeners, unsubscribe, all dropped on dispose', async () => {
    const seen: unknown[] = [];
    const off = b.on('settings', (_s, patch) => seen.push(patch));
    b.on('externalSettings', () => {});
    await b.call('saveSettings', [{ theme: 'light' }]);
    off();
    await b.call('saveSettings', [{ theme: 'dark' }]);
    expect(seen).toEqual([{ theme: 'light' }]);
    const late: unknown[] = [];
    b.on('settings', (_s, patch) => late.push(patch));
    await b.dispose();
    await service.saveSettings({ theme: 'system' });
    expect(late).toEqual([]);
  });

  it('after dispose: calls reject, notices are ignored', async () => {
    await b.openWorkspace(root);
    await b.dispose();
    expect(await code(b.call('getWorkspace', []))).toBe('EIO');
    expect(await code(b.openWorkspace(root))).toBe('EIO');
    expect(await b.gitNumstat()).toBeNull();
    b.queueOpenRequest(path.join(root, 'a.md'));
    expect(service.openRequests).toEqual([]);
    expect(() => b.setWatchPaused(true)).not.toThrow();
  });
});

describe('createInProcessBackend: a call still running when the window closes', () => {
  it('closes the service again once it ends (no folder, watcher or git monitor left behind)', async () => {
    let finish!: () => void;
    let disposed = 0;
    const fake = {
      workspace: null,
      openRequests: [],
      getWorkspace: async () => null,
      openWorkspace: () => new Promise<void>((r) => (finish = r)),
      dispose: () => void disposed++,
    } as unknown as BackendService;
    const fb = createInProcessBackend(fake);
    const open = fb.openWorkspace('/somewhere');
    await fb.dispose();
    expect(disposed).toBe(1);
    finish();
    await open;
    expect(disposed).toBe(2);
  });
});
