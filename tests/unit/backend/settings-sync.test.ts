// The desktop app and a browser-mode server share settings.json: writes merge (only the changed keys,
// under a cross-process lock), and each side picks up the other's changes live (file watch).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackendService } from '../../../src/backend/service';
import { withFileLock } from '../../../src/backend/filelock';

let tmp: string;
let cfg: string;
const services: BackendService[] = [];
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-settings-sync-'));
  cfg = path.join(tmp, 'config');
});
afterEach(async () => {
  for (const s of services.splice(0)) s.dispose();
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

async function service(kind: 'desktop' | 'web' = 'desktop') {
  const s = new BackendService(cfg, { sessionKind: kind });
  services.push(s);
  await s.getSettings(); // loaded = an in-memory copy that the other side's writes make stale
  return s;
}
const disk = () => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));

describe('settings shared by desktop and browser mode', () => {
  it('desktop sets A while a browser client sets B: both survive, each side sees the other live', async () => {
    const desk = await service('desktop');
    const web = await service('web');
    const deskSaw: unknown[] = [];
    const webSaw: unknown[] = [];
    desk.onExternalSettings((p) => deskSaw.push(p));
    web.onExternalSettings((p) => webSaw.push(p));
    await Promise.all([desk.saveSettings({ theme: 'light' }), web.saveSettings({ fontSize: 19 })]);
    expect(disk()).toMatchObject({ theme: 'light', fontSize: 19 });
    await vi.waitFor(async () => {
      expect((await desk.getSettings()).fontSize).toBe(19);
      expect((await web.getSettings()).theme).toBe('light');
    });
    expect(deskSaw).toContainEqual({ fontSize: 19 });
    expect(webSaw).toContainEqual({ theme: 'light' });
    // Own writes are never reported back as external.
    expect(deskSaw.some((p) => 'theme' in (p as object))).toBe(false);
    expect(webSaw.some((p) => 'fontSize' in (p as object))).toBe(false);
  });

  it('a burst of saves from both processes loses nothing', async () => {
    const desk = await service('desktop');
    const web = await service('web');
    const saves: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      saves.push(desk.saveSettings({ [`test.desk${i}`]: i }));
      saves.push(web.saveSettings({ [`test.web${i}`]: i }));
    }
    await Promise.all(saves);
    const d = disk();
    for (let i = 0; i < 12; i++) expect([d[`test.desk${i}`], d[`test.web${i}`]]).toEqual([i, i]);
    expect(fs.readdirSync(cfg).filter((n) => /\.tmp$|\.lock$/.test(n))).toEqual([]);
  });

  it('listeners also hear external changes (main applies the theme), and the workspace options follow', async () => {
    const desk = await service('desktop');
    const seen: unknown[] = [];
    desk.onSettingsChanged((_s, patch) => seen.push(patch));
    const web = await service('web');
    await web.saveSettings({ theme: 'dark', sidebarStyle: 'classic' });
    await vi.waitFor(() => expect(seen).toContainEqual({ sidebarStyle: 'classic' }));
  });

  it('a change of ours still waiting for the lock is not reverted by a file event in between', async () => {
    const desk = await service('desktop');
    await desk.saveSettings({ fontSize: 14 });
    const lock = path.join(cfg, 'settings.json.lock');
    fs.writeFileSync(lock, ''); // another writer holds the lock
    const saving = desk.saveSettings({ fontSize: 22 });
    // Meanwhile someone rewrites the file with the old value of our key plus a new one of theirs.
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ ...disk(), fontSize: 14, theme: 'light' }));
    await vi.waitFor(async () => expect((await desk.getSettings()).theme).toBe('light'));
    expect((await desk.getSettings()).fontSize).toBe(22);
    fs.rmSync(lock);
    await saving;
    expect(disk()).toMatchObject({ fontSize: 22, theme: 'light' });
  });

  it('a lock left by a crashed writer goes stale; a missing settings folder is created', async () => {
    const desk = await service('desktop');
    const lock = path.join(cfg, 'settings.json.lock');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    await desk.saveSettings({ wordWrap: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(disk().wordWrap).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('withFileLock', () => {
  it('serialises holders of the same file', async () => {
    const target = path.join(tmp, 'x.json');
    let inside = 0;
    let overlap = false;
    const hold = () =>
      withFileLock(target, async () => {
        if (++inside > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 15));
        inside--;
      });
    await Promise.all([hold(), hold(), hold(), hold()]);
    expect(overlap).toBe(false);
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });
});
