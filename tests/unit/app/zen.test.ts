// @vitest-environment happy-dom
// Zen mode state: what entering closes, that leaving restores exactly the layout before, the keep
// options, and persistence (session + the skeleton's cached attribute read by theme-boot.js).
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { app } from '../../../src/renderer/app/app';
import * as ui from '../../../src/renderer/app/ui';
import { installZenImpl, setZen, toggleZen } from '../../../src/renderer/app/zen-impl';
import { applySessionLayout, sessionSnapshot } from '../../../src/renderer/app/documents';
import { panelOpen } from '../../../src/renderer/terminal/state';

const layout = () => ({ sidebar: app.sidebarVisible.value, panel: app.sidebarPanel.value, overview: ui.overviewVisible.value, processes: ui.processesOpen.value, terminal: panelOpen.value });
const cache = () => JSON.parse(localStorage.getItem('sec-edit-layout') ?? 'null');
const settings = (patch: Record<string, unknown>) => (app.settings.value = { ...DEFAULT_SETTINGS, ...patch });

for (const id of ['files', 'git', 'search']) app.registerPanel({ id, title: id, icon: id, component: () => null });
installZenImpl();

beforeEach(() => {
  setZen(false);
  settings({});
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = 'git';
  ui.overviewVisible.value = true;
  ui.processesOpen.value = true;
  panelOpen.value = true;
  localStorage.removeItem('sec-edit-layout');
});

describe('zen mode', () => {
  it('closes every panel, and leaving restores exactly the layout before', () => {
    const before = layout();
    toggleZen();
    expect(ui.zen.value).not.toBeNull();
    expect(layout()).toEqual({ sidebar: false, panel: 'git', overview: false, processes: false, terminal: false });
    toggleZen();
    expect(ui.zen.value).toBeNull();
    expect(layout()).toEqual(before);
  });

  it('a panel opened in zen shows, and leaving still restores the layout from before zen', () => {
    app.sidebarVisible.value = false;
    ui.overviewVisible.value = false;
    const before = layout();
    setZen(true);
    app.sidebarVisible.value = true; // e.g. Ctrl+Shift+F / Ctrl+Shift+G in zen
    app.sidebarPanel.value = 'search';
    setZen(false);
    expect(layout()).toEqual(before);
  });

  it('"Keep the file tree": the sidebar stays on Files (if it was showing); toggling it in zen applies at once', () => {
    settings({ 'zen.keepFileTree': true });
    setZen(true);
    expect(layout()).toMatchObject({ sidebar: true, panel: 'files', overview: false });
    settings({ 'zen.keepFileTree': false });
    expect(app.sidebarVisible.value).toBe(false);
    settings({ 'zen.keepFileTree': true });
    expect(layout()).toMatchObject({ sidebar: true, panel: 'files' });
    setZen(false);
    expect(layout()).toMatchObject({ sidebar: true, panel: 'git', overview: true });
    // A sidebar hidden before zen stays hidden: zen never adds chrome.
    app.sidebarVisible.value = false;
    setZen(true);
    expect(app.sidebarVisible.value).toBe(false);
  });

  it('is saved with the session (without the terminal) and restored from it', () => {
    setZen(true);
    const snap = sessionSnapshot();
    expect(snap.zen).toEqual({ sidebarVisible: true, sidebarPanel: 'git', overviewVisible: true, processesOpen: true });
    expect(snap.sidebarVisible).toBe(false); // the zen layout itself is what the session holds
    setZen(false);
    panelOpen.value = false; // a new window: terminals start closed
    applySessionLayout(JSON.parse(JSON.stringify(snap)));
    expect(ui.zen.value).toMatchObject({ sidebarVisible: true, sidebarPanel: 'git' });
    expect(app.sidebarVisible.value).toBe(false);
    setZen(false);
    expect(layout()).toMatchObject({ sidebar: true, panel: 'git', overview: true, processes: true, terminal: false });
    // A session without zen (another folder) turns it off.
    setZen(true);
    applySessionLayout({ openTabs: [], activeTab: null });
    expect(ui.zen.value).toBeNull();
  });

  it('caches the skeleton attribute for theme-boot.js and keeps <html data-zen> in sync', () => {
    setZen(true);
    expect(cache().z).toBe('on');
    expect(document.documentElement.dataset.zen).toBe('on');
    settings({ 'zen.keepStatusBar': true });
    expect(cache().z).toBe('on status');
    expect(document.documentElement.dataset.zen).toBe('on status');
    setZen(false);
    expect(cache().z).toBeUndefined();
    expect(document.documentElement.dataset.zen).toBeUndefined();
  });
});

describe('theme-boot.js (before first paint)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/public/theme-boot.js'), 'utf8');
  const boot = (store: Record<string, string>) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(store)) localStorage.setItem(`sec-edit-${k}`, v);
    const d = document.documentElement;
    for (const a of ['data-zen', 'data-folders', 'data-sb']) d.removeAttribute(a);
    document.getElementById('se-folder')?.remove();
    new Function(src)();
    return d;
  };

  it('sets data-zen from the cached layout (with the kept status bar), and nothing when off', () => {
    expect(boot({ layout: JSON.stringify({ sb: false, z: 'on' }) }).dataset).toMatchObject({ zen: 'on', sb: '0' });
    expect(boot({ layout: JSON.stringify({ z: 'on status' }) }).getAttribute('data-zen')).toBe('on status');
    expect(boot({ layout: JSON.stringify({ sb: true }) }).hasAttribute('data-zen')).toBe(false);
  });

  it('applies the folder colour mode and its cached stylesheet', () => {
    const d = boot({ folders: 'one', folder: '/*#ef4444*/html:root:root{--folder-color:#ef4444}' });
    expect(d.dataset.folders).toBe('one');
    expect(document.getElementById('se-folder')?.textContent).toContain('--folder-color:#ef4444');
    expect(boot({}).hasAttribute('data-folders')).toBe(false);
    expect(document.getElementById('se-folder')).toBeNull();
  });
});
