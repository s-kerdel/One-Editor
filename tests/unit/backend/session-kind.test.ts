// Desktop and browser mode on the same folder keep their own session (open tabs, tree, layout):
// a browser tab must never overwrite the desktop's tabs, and vice versa. Settings stay shared.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackendService } from '../../../src/backend/service';
import { startServer, type RunningServer } from '../../../src/server/server';

let tmp: string;
let root: string;
let cfg: string;
const open: Array<{ dispose(): void }> = [];
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-session-kind-'));
  root = path.join(tmp, 'notes');
  cfg = path.join(tmp, 'config');
  await fsp.mkdir(root, { recursive: true });
  for (const f of ['a.md', 'b.md', 'c.md']) await fsp.writeFile(path.join(root, f), f);
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
const sessionFiles = () => fs.readdirSync(path.join(cfg, 'sessions')).sort();

describe('session per client kind', () => {
  it('desktop and web keep independent tabs across restarts; settings are shared', async () => {
    const desk = await service();
    await desk.saveSession({ openTabs: ['a.md'], activeTab: 'a.md', expanded: ['x'], overviewVisible: true });
    const web = await service('web');
    await web.saveSession({ openTabs: ['b.md', 'c.md'], activeTab: 'c.md', expanded: [], overviewVisible: false });
    await desk.saveSettings({ theme: 'light' });

    // "Restart": fresh instances read the files.
    const desk2 = await service('desktop');
    const web2 = await service('web');
    expect(await desk2.getSession()).toMatchObject({ openTabs: ['a.md'], activeTab: 'a.md', expanded: ['x'], overviewVisible: true });
    expect(await web2.getSession()).toMatchObject({ openTabs: ['b.md', 'c.md'], activeTab: 'c.md', expanded: [], overviewVisible: false });
    expect((await web2.getSettings()).theme).toBe('light');
    const [deskFile, webFile] = sessionFiles();
    expect(webFile).toBe(deskFile.replace(/\.json$/, '@web.json'));
  });

  it('a first browser visit starts from the desktop session but never writes it back', async () => {
    const desk = await service();
    await desk.saveSession({ openTabs: ['a.md', 'b.md'], activeTab: 'b.md', sidebarWidth: 310 });
    const deskPath = path.join(cfg, 'sessions', sessionFiles()[0]);
    const before = fs.readFileSync(deskPath, 'utf8');

    const web = await service('web');
    expect(await web.getSession()).toMatchObject({ openTabs: ['a.md', 'b.md'], activeTab: 'b.md', sidebarWidth: 310 });
    await web.saveSession({ openTabs: ['c.md'], activeTab: 'c.md' });
    expect(fs.readFileSync(deskPath, 'utf8')).toBe(before);
    expect(await web.getSession()).toMatchObject({ openTabs: ['c.md'], activeTab: 'c.md' });

    // Once the browser has its own, later desktop changes no longer leak into it.
    await desk.saveSession({ openTabs: ['a.md'], activeTab: 'a.md' });
    expect((await (await service('web')).getSession()).openTabs).toEqual(['c.md']);
  });

  it('nothing to seed from: an empty session; a broken file is treated as empty', async () => {
    const web = await service('web');
    expect(await web.getSession()).toEqual({ openTabs: [], activeTab: null });
    await web.saveSession({ openTabs: ['a.md'], activeTab: 'a.md' });
    fs.writeFileSync(path.join(cfg, 'sessions', sessionFiles()[0]), '{ truncated');
    expect(await (await service('web')).getSession()).toEqual({ openTabs: [], activeTab: null });
  });

  it('every HTTP server (browser mode) uses the web session', async () => {
    const srv: RunningServer = await startServer({ root, port: 0, rendererDir: tmp, configDir: cfg });
    open.push({ dispose: () => void srv.close() });
    const rpc = (m: string, args: unknown[]) =>
      fetch(`${srv.origin}api/rpc/${m}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': srv.token }, body: JSON.stringify({ args }) }).then((r) => r.json());
    expect(await rpc('saveSession', [{ openTabs: ['b.md'], activeTab: 'b.md' }])).toMatchObject({ ok: true });
    expect(sessionFiles()).toEqual([expect.stringMatching(/^[a-f0-9]{16}@web\.json$/)]);
    expect((await (await service()).getSession()).openTabs).toEqual([]); // the desktop's own is untouched
  });
});
