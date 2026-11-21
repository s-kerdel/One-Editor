// @vitest-environment happy-dom
// Folder colours (Settings → Appearance): the mode and the one colour → <html data-folders> and the
// derived --folder-color stylesheet (cached for theme-boot.js), readable in both themes.
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { contrast, folderColor, folderCss, hexToRgb } from '../../../src/renderer/app/accent';
import { FOLDER_SWATCHES, settingByKey } from '../../../src/renderer/app/settings-registry';
import { applySettingsToDom } from '../../../src/renderer/app/settings';

// Backgrounds a tree row can have (styles/app.css): shelf backdrop, classic sidebar, hover row.
const BGS = { dark: ['#131519', '#16181c', '#262a31'], light: ['#f0f0ed', '#f6f6f5', '#ebebe9'] };
const ok = (hex: string, theme: 'dark' | 'light') => BGS[theme].every((bg) => contrast(hexToRgb(hex), hexToRgb(bg)) >= 3);
const apply = (patch: Record<string, unknown>) => applySettingsToDom({ ...DEFAULT_SETTINGS, ...patch } as Settings);
const sheet = () => document.getElementById('se-folder')?.textContent ?? null;

describe('folder colour derivation', () => {
  it('every swatch and extreme pick stays visible in both themes; good picks are used as picked', () => {
    const picks = [...FOLDER_SWATCHES.map((s) => String(s.v)).filter(Boolean), '#000000', '#ffffff', '#ffff00', '#101820'];
    for (const hex of picks) for (const t of ['dark', 'light'] as const) expect(ok(folderColor(hex, t), t), `${hex} ${t}`).toBe(true);
    expect(folderColor('#ef4444', 'dark')).toBe('#ef4444');
    expect(folderColor('#8f96a3', 'dark')).toBe('#8f96a3'); // classic's grey itself
    expect(folderColor('#eab308', 'light')).not.toBe('#eab308'); // yellow on a light shelf: darkened
  });

  it('builds one stylesheet for dark, light and system, tagged with the colour', () => {
    const css = folderCss('#EAB308');
    expect(css.startsWith('/*#eab308*/html:root:root{--folder-color:#eab308}')).toBe(true);
    expect(css).toContain(`html[data-theme='light']:root:root{--folder-color:${folderColor('#eab308', 'light')}}`);
    expect(css).toContain("@media (prefers-color-scheme:light){html[data-theme='system']:root:root{--folder-color:");
  });

  it('per top-level folder is the default; the colour defaults to classic grey and needs "One colour"', () => {
    expect(settingByKey('tree.folderColors')!.default).toBe('hue');
    const c = settingByKey('tree.folderColor')!;
    expect(c.default).toBe('');
    expect(c.control).toMatchObject({ type: 'color', base: 'var(--ft-folder)' });
    expect(c.enabledWhen!({ 'tree.folderColors': 'hue' })).toBe(false);
    expect(c.enabledWhen!({ 'tree.folderColors': 'one' })).toBe(true);
  });
});

describe('setting → DOM', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('se-folder')?.remove();
  });

  it('"One colour" sets html[data-folders] (cached for the boot script); per folder removes it', () => {
    apply({ 'tree.folderColors': 'one' });
    expect(document.documentElement.dataset.folders).toBe('one');
    expect(localStorage.getItem('sec-edit-folders')).toBe('one');
    apply({});
    expect(document.documentElement.dataset.folders).toBeUndefined();
    expect(localStorage.getItem('sec-edit-folders')).toBeNull();
  });

  it('a picked colour installs and caches --folder-color; reset removes both', async () => {
    apply({ 'tree.folderColors': 'one', 'tree.folderColor': '#EF4444' });
    await expect.poll(sheet).toContain('--folder-color:#ef4444');
    expect(localStorage.getItem('sec-edit-folder')).toBe(sheet());
    apply({ 'tree.folderColors': 'one', 'tree.folderColor': '' });
    expect(sheet()).toBeNull();
    expect(localStorage.getItem('sec-edit-folder')).toBeNull();
    // Junk in a hand-edited settings file is ignored (classic grey).
    apply({ 'tree.folderColors': 'one', 'tree.folderColor': 'red' });
    expect(sheet()).toBeNull();
  });
});
