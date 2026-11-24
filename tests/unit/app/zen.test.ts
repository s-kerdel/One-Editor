// @vitest-environment happy-dom
// Zen mode state: entering folds the sidebar / overview into strips and closes the bottom panels (the
// terminal only with zen.keepTerminal off), a panel shown in zen is a peek, leaving restores exactly the
// layout before; options (full screen, status bar, terminal, the retired keepFileTree); full screen
// requests; persistence (session + the skeleton's cached attribute).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { app } from '../../../src/renderer/app/app';
import * as ui from '../../../src/renderer/app/ui';
import { installZenImpl, setZen, toggleZen, zenOptions } from '../../../src/renderer/app/zen-impl';
import { applySessionLayout, persistSession, sessionSnapshot } from '../../../src/renderer/app/documents';
import { settingByKey } from '../../../src/renderer/app/settings-registry';
import { panelOpen } from '../../../src/renderer/terminal/state';

const layout = () => ({ sidebar: app.sidebarVisible.value, panel: app.sidebarPanel.value, overview: ui.overviewVisible.value, processes: ui.processesOpen.value, terminal: panelOpen.value });
const cache = () => JSON.parse(localStorage.getItem('sec-edit-layout') ?? 'null');
const settings = (patch: Record<string, unknown>) => (app.settings.value = { ...DEFAULT_SETTINGS, ...patch });
const fullScreen = vi.fn();
(app as any).backend = { kind: 'electron', zenFullScreen: fullScreen };

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
  fullScreen.mockClear();
});

describe('zen mode', () => {
  it('keepTerminal off (the old behaviour): folds the sidebar and the overview into strips, closes the bottom panels; leaving restores exactly the layout before', () => {
    settings({ 'zen.keepTerminal': false });
    const before = layout();
    toggleZen();
    expect(ui.zen.value).toMatchObject({ sidebarVisible: true, sidebarPanel: 'git', overviewVisible: true });
    expect(layout()).toEqual({ sidebar: false, panel: 'git', overview: false, processes: false, terminal: false });
    toggleZen();
    expect(ui.zen.value).toBeNull();
    expect(layout()).toEqual(before);
  });

  it('keepTerminal on (the default): entering zen keeps the terminal open, and a panel the user closed in zen stays closed on leaving', () => {
    const before = layout(); // terminal open, like the case above
    toggleZen();
    expect(layout()).toEqual({ sidebar: false, panel: 'git', overview: false, processes: false, terminal: true });
    expect(ui.zen.value!.terminal).toBeUndefined(); // nothing saved: leaving has nothing to force back open
    panelOpen.value = false; // Ctrl+` in zen hides the panel
    toggleZen();
    expect(ui.zen.value).toBeNull();
    expect(layout()).toEqual({ ...before, terminal: false });
  });

  it('a peek opened in zen (strip, shortcut) is the panel’s own signal; leaving still restores the layout from before zen', () => {
    app.sidebarVisible.value = false;
    ui.overviewVisible.value = false;
    const before = layout();
    setZen(true);
    app.sidebarVisible.value = true; // e.g. a strip icon or Ctrl+Shift+F in zen
    app.sidebarPanel.value = 'search';
    ui.overviewVisible.value = true;
    setZen(false);
    expect(layout()).toEqual(before);
  });

  it('ignores a stored "zen.keepFileTree" (zen before the strips): the sidebar folds anyway, no control is left for it', () => {
    settings({ 'zen.keepFileTree': true });
    setZen(true);
    expect(app.sidebarVisible.value).toBe(false);
    expect(settingByKey('zen.keepFileTree')).toBeUndefined();
    expect(zenOptions({ 'zen.keepFileTree': true })).toEqual({ fullScreen: true, keepStatusBar: false, keepTerminal: true });
  });

  it('reads its options leniently: full screen unless explicitly off, the status bar only when explicitly kept, the terminal unless explicitly off', () => {
    expect(zenOptions({})).toEqual({ fullScreen: true, keepStatusBar: false, keepTerminal: true });
    expect(zenOptions({ 'zen.fullScreen': null, 'zen.keepStatusBar': 'yes' })).toEqual({ fullScreen: true, keepStatusBar: false, keepTerminal: true });
    expect(zenOptions({ 'zen.fullScreen': false, 'zen.keepStatusBar': true, 'zen.keepTerminal': false })).toEqual({ fullScreen: false, keepStatusBar: true, keepTerminal: false });
    expect(zenOptions({ 'zen.keepTerminal': null })).toEqual({ fullScreen: true, keepStatusBar: false, keepTerminal: true });
    expect(settingByKey('zen.fullScreen')?.default).toBe(true);
    expect(settingByKey('zen.keepStatusBar')?.default).toBe(false);
    expect(settingByKey('zen.keepTerminal')?.default).toBe(true);
  });
});

describe('full screen', () => {
  it('asks for it on entering and gives it back on leaving (desktop: main restores the state from before)', () => {
    setZen(true);
    expect(fullScreen.mock.calls).toEqual([[true]]);
    setZen(true); // no flip, no request
    setZen(false);
    expect(fullScreen.mock.calls).toEqual([[true], [false]]);
  });

  it('"Full screen" off: zen stays windowed; switching it in zen applies at once', () => {
    settings({ 'zen.fullScreen': false });
    setZen(true);
    expect(fullScreen.mock.calls).toEqual([]);
    settings({ 'zen.fullScreen': true });
    expect(fullScreen.mock.calls.at(-1)).toEqual([true]);
    settings({ 'zen.fullScreen': false });
    expect(fullScreen.mock.calls.at(-1)).toEqual([false]);
    setZen(false);
    expect(fullScreen.mock.calls.at(-1)).toEqual([false]);
  });

  it('a zen the session restores goes full screen too; a session without zen gives it back', () => {
    applySessionLayout({ openTabs: [], activeTab: null, zen: { sidebarVisible: true, sidebarPanel: 'git', overviewVisible: false, processesOpen: false } });
    expect(fullScreen.mock.calls).toEqual([[true]]);
    applySessionLayout({ openTabs: [], activeTab: null });
    expect(ui.zen.value).toBeNull();
    expect(fullScreen.mock.calls).toEqual([[true], [false]]);
  });
});

describe('persistence', () => {
  it('is saved with the session (without the terminal) and restored from it, with no peek open', () => {
    setZen(true);
    app.sidebarVisible.value = true; // a peek at the moment of the save
    const snap = sessionSnapshot();
    expect(snap.zen).toEqual({ sidebarVisible: true, sidebarPanel: 'git', overviewVisible: true, processesOpen: true });
    setZen(false);
    panelOpen.value = false; // a new window: terminals start closed
    applySessionLayout(JSON.parse(JSON.stringify(snap)));
    expect(ui.zen.value).toMatchObject({ sidebarVisible: true, sidebarPanel: 'git' });
    expect(app.sidebarVisible.value).toBe(false); // the peek is not restored
    setZen(false);
    // The session never carries the terminal (zenSaved drops it) and with zen.keepTerminal on leaving zen
    // does not touch the panel at all, so a restored zen leaves it closed either way.
    expect(layout()).toMatchObject({ sidebar: true, panel: 'git', overview: true, processes: true, terminal: false });
  });

  it('an old zen session that kept the file tree comes back folded', () => {
    applySessionLayout({ openTabs: [], activeTab: null, sidebarVisible: true, overviewVisible: true, zen: { sidebarVisible: true, sidebarPanel: 'files', overviewVisible: false, processesOpen: false } });
    expect(ui.zen.value).not.toBeNull();
    expect(layout()).toMatchObject({ sidebar: false, overview: false });
  });

  it('caches the skeleton attribute for theme-boot.js (status bar, overview strip) and never a peek', () => {
    setZen(true); // the overview was open: it gets a strip
    expect(cache().z).toBe('on ov');
    expect(document.documentElement.dataset.zen).toBe('on ov');
    settings({ 'zen.keepStatusBar': true });
    expect(cache().z).toBe('on status ov');
    ui.overviewVisible.value = true; // peek
    persistSession();
    expect(cache().ov).toBe(false);
    setZen(false);
    expect(cache().z).toBeUndefined();
    expect(cache().ov).toBe(true);
    expect(document.documentElement.dataset.zen).toBeUndefined();
    ui.overviewVisible.value = false;
    setZen(true);
    expect(cache().z).toBe('on status');
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

  it('sets data-zen from the cached layout (old values too), and nothing when off', () => {
    expect(boot({ layout: JSON.stringify({ sb: false, z: 'on' }) }).dataset).toMatchObject({ zen: 'on', sb: '0' });
    expect(boot({ layout: JSON.stringify({ z: 'on status ov' }) }).getAttribute('data-zen')).toBe('on status ov');
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
