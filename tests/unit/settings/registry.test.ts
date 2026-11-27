import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { SECTIONS, SETTINGS, filterSettings, isChanged, parseList, parseNumber, rankSettings, resetPatch, scoreSetting, settingByKey, shortcutRows, valueOf } from '../../../src/renderer/app/settings-registry';
import { optionsFromSettings } from '../../../src/format/config';

const keys = (q: string) => filterSettings(q).map((d) => d.key);
const def = (k: string) => settingByKey(k)!;

describe('settings registry', () => {
  it('browser mode greys out what its server will not write: the remote-images default', () => {
    // A taken-over page in browser mode must not turn remote images on; the pinned server drops the write.
    expect(def('preview.remoteImages').desktopOnly).toBe(true);
  });

  it('has unique keys and DOM ids, and every setting belongs to a known section', () => {
    expect(new Set(SETTINGS.map((d) => d.key)).size).toBe(SETTINGS.length);
    expect(new Set(SETTINGS.map((d) => d.id)).size).toBe(SETTINGS.length);
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const d of SETTINGS) expect(sections.has(d.section), d.key).toBe(true);
    // No empty section in the nav (shortcuts is generated from the command registry).
    for (const s of SECTIONS) if (s.id !== 'shortcuts') expect(SETTINGS.some((d) => d.section === s.id), s.id).toBe(true);
  });

  it('covers every key of DEFAULT_SETTINGS with the same default', () => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (k === 'lineNumbers') continue; // legacy key, superseded by markdownLineNumbers (no control any more)
      expect(def(k), k).toBeTruthy();
      expect(def(k).default, k).toEqual(v);
    }
  });

  it('covers every dotted setting key that the source reads', () => {
    // Guards against a new `app.settings.value['x.y']` that never gets a control.
    const root = path.resolve(__dirname, '../../../src');
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/settings-registry\.ts$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          for (const m of text.matchAll(/(?:settings\.value\[|setting(?:<\w+>)?\(|num\(|bool\(|s\[)\s*'([a-z]+\.[A-Za-z]+)'/g)) found.add(m[1]);
        }
      }
    };
    walk(root);
    expect(found.size).toBeGreaterThan(10);
    for (const k of found) expect(def(k), `no Settings control for "${k}"`).toBeTruthy();
  });

  it('every description is a single short line; choices are unique and contain the default', () => {
    for (const d of SETTINGS) {
      expect(d.description.length, d.key).toBeLessThanOrEqual(100);
      expect(d.description).not.toContain('\n');
      if ((d.control.type === 'select' || d.control.type === 'segmented') && d.key !== 'zoom') {
        const vs = d.control.options.map((o) => o.v);
        expect(new Set(vs).size, d.key).toBe(vs.length);
        expect(vs, d.key).toContain(d.default);
      }
      if (d.control.type === 'number' && typeof d.default === 'number') {
        expect(d.default).toBeGreaterThanOrEqual(d.control.min);
        expect(d.default).toBeLessThanOrEqual(d.control.max);
      }
    }
  });
});

describe('values, change detection and reset', () => {
  it('treats missing and null as the default', () => {
    expect(valueOf(def('daily.folder'), {})).toBe('daily');
    expect(valueOf(def('daily.folder'), { 'daily.folder': null })).toBe('daily');
    expect(isChanged(def('daily.folder'), {})).toBe(false);
    expect(isChanged(def('daily.folder'), { 'daily.folder': 'journal' })).toBe(true);
    expect(isChanged(def('format.printWidth'), { 'format.printWidth': null })).toBe(false);
    expect(isChanged(def('format.printWidth'), { 'format.printWidth': 100 })).toBe(true);
    expect(isChanged(def('format.singleQuote'), { 'format.singleQuote': false })).toBe(true);
  });

  it('compares lists by content', () => {
    expect(isChanged(def('excludeGlobs'), { excludeGlobs: [...DEFAULT_SETTINGS.excludeGlobs] })).toBe(false);
    expect(isChanged(def('excludeGlobs'), { excludeGlobs: ['node_modules'] })).toBe(true);
  });

  it('nothing is "changed" on a fresh install', () => {
    expect(SETTINGS.filter((d) => isChanged(d, DEFAULT_SETTINGS))).toEqual([]);
  });

  it('reset writes an explicit JSON-safe value (never undefined) and copies arrays', () => {
    for (const d of SETTINGS) {
      const patch = resetPatch(d);
      expect(patch[d.key], d.key).not.toBeUndefined();
      expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
      expect(isChanged(d, { ...patch })).toBe(false);
    }
    expect(resetPatch(def('excludeGlobs')).excludeGlobs).not.toBe(DEFAULT_SETTINGS.excludeGlobs);
    expect(resetPatch(def('format.phpVersion'))).toEqual({ 'format.phpVersion': null });
  });

  it('a reset formatter setting falls back to the language defaults', () => {
    const all = Object.assign({}, ...SETTINGS.filter((d) => d.key.startsWith('format.')).map(resetPatch));
    // useTabs:false and keyword case "upper" equal the formatter's own defaults; everything else is unset.
    expect(optionsFromSettings(all)).toEqual({ useTabs: false, sqlKeywordCase: 'upper' });
  });

  it('parses lists and numbers', () => {
    expect(parseList(' a, b\n\nc ,')).toEqual(['a', 'b', 'c']);
    const c = { min: 20, max: 400 };
    expect(parseNumber('120', c, true)).toBe(120);
    expect(parseNumber('', c, true)).toBeNull();
    expect(parseNumber('', c, false)).toBeUndefined();
    expect(parseNumber('5', c, true)).toBeUndefined();
    expect(parseNumber('abc', c, true)).toBeUndefined();
  });
});

describe('settings search', () => {
  it('empty query keeps everything in registry order', () => {
    expect(filterSettings('')).toEqual(SETTINGS);
    expect(filterSettings('   ')).toEqual(SETTINGS);
  });

  it('matches by label, key, keyword, section and description', () => {
    expect(keys('php')).toContain('format.phpVersion');
    expect(keys('PHP VERSION')).toEqual(['format.phpVersion']);
    expect(keys('format.sql')).toEqual(['format.sqlKeywordCase']);
    expect(keys('lineBreaks')).toEqual(['preview.lineBreaks']);
    expect(keys('node_modules')).toEqual(['excludeGlobs']); // keyword
    expect(keys('attachments').sort()).toEqual(['attachments.folder', 'attachments.location']);
    expect(keys('gutter')).toEqual(['markdownLineNumbers']);
    expect(settingByKey('lineNumbers')).toBeUndefined();
    expect(keys('toolbar')).toEqual(['formatToolbar']);
    expect(keys('accent')).toEqual(['accentColor']);
    expect(keys('square')).toEqual(['cornerStyle']);
    expect(keys('compact')).toContain('uiDensity');
    expect(keys('line height')).toEqual(['editorLineHeight']);
    expect(keys('full width')).toEqual(['contentWidth']);
    expect(keys('trash')).toEqual(['confirmDelete']);
  });

  it('is fuzzy on label and key, but not on prose', () => {
    expect(keys('phpv')).toEqual(['format.phpVersion']);
    expect(keys('fntsz')).toEqual(['fontSize', 'terminal.fontSize']); // the editor's first, then the terminal's
    expect(keys('wrdwrap')).toContain('wordWrap');
    expect(keys('zzzqqq')).toEqual([]);
    expect(keys('xq')).toEqual([]);
  });

  it('needs every word to match', () => {
    expect(rankSettings('daily folder')[0].key).toBe('daily.folder');
    expect(keys('daily folder')).not.toContain('templates.folder');
    expect(keys('daily zzz')).toEqual([]);
    expect(keys('tab width')).toEqual(['format.tabWidth']);
  });

  it('ranks a label hit above a description hit', () => {
    expect(rankSettings('php')[0].key).toBe('format.phpVersion');
    expect(rankSettings('theme')[0].key).toBe('theme');
    expect(scoreSetting('php', def('format.phpVersion'))).toBeGreaterThan(scoreSetting('php', def('format.tabWidth')));
    expect(scoreSetting('php', def('theme'))).toBe(0);
  });
});

describe('shortcut table', () => {
  const cmds = [
    { id: 'format.document', title: 'Format document', category: 'Format', keys: ['Shift-Alt-f', 'Alt-Shift-f'], keywords: ['prettier'] },
    { id: 'editor.bold', title: 'Format: Toggle bold', displayKeys: ['Mod-b'] },
    { id: 'tabs.next', title: 'Next tab', category: 'Tabs', keys: ['Ctrl-Tab', 'Mod-Tab'] },
    { id: 'file.saveAll', title: 'File: Save all' },
    { id: 'palette.files', title: 'Go to file…', category: 'Go', keys: ['Mod-p', 'Mod-o'] },
  ];
  const pretty = (k: string) => k.replace('Mod', 'Ctrl').replace(/-/g, '+');

  it('lists only commands with a binding, grouped by category then title', () => {
    const rows = shortcutRows(cmds, '', pretty);
    expect(rows.map((r) => `${r.category}/${r.title}`)).toEqual(['Format/Format document', 'Format/Toggle bold', 'Go/Go to file…', 'Tabs/Next tab']);
  });

  it('collapses duplicate spellings of one chord and keeps real alternatives', () => {
    const rows = shortcutRows(cmds, '', pretty);
    expect(rows.find((r) => r.id === 'format.document')!.keys).toEqual(['Alt-Shift-f']);
    expect(rows.find((r) => r.id === 'tabs.next')!.keys).toEqual(['Ctrl-Tab']);
    expect(rows.find((r) => r.id === 'palette.files')!.keys).toEqual(['Mod-p', 'Mod-o']);
  });

  it('filters by title, category, keyword and key', () => {
    const ids = (q: string) => shortcutRows(cmds, q, pretty).map((r) => r.id);
    expect(ids('format document')).toEqual(['format.document']);
    expect(ids('prettier')).toEqual(['format.document']);
    expect(ids('tabs')).toEqual(['tabs.next']);
    expect(ids('ctrl+b')).toEqual(['editor.bold']);
    expect(ids('frmt doc')).toEqual(['format.document']);
    expect(ids('zzzqqq')).toEqual([]);
  });
});
