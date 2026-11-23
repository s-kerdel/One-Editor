// @vitest-environment happy-dom
// Settings → Files → File type associations: rows of pattern → language, add / change / remove, validation as
// you type, and what gets stored (setting `files.associations`; null = none).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { app } from '../../../src/renderer/app/app';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { MAX_ASSOCIATIONS } from '../../../src/shared/associations';
import { FileTypesControl } from '../../../src/renderer/app/FileTypesSetting';
import { fileAssociations, setFileAssociation } from '../../../src/renderer/app/file-types';
import { flushSettings } from '../../../src/renderer/app/settings';
import { settingByKey, isChanged, resetPatch } from '../../../src/renderer/app/settings-registry';

let root: HTMLElement;
let saved: Array<Partial<Settings>>;
const stored = () => app.settings.value['files.associations'];
const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const rows = () => [...root.querySelectorAll<HTMLElement>('.se-assoc-item')].map((li) => `${li.dataset.pattern} → ${li.querySelector('select')!.value}`);
const note = () => q('.se-assoc-note')!.textContent ?? '';
const input = () => q<HTMLInputElement>('#assoc')!;
const addBtn = () => q<HTMLButtonElement>('[data-testid="assoc-add"]')!;
const langSelect = () => q<HTMLSelectElement>('[data-testid="assoc-language"]')!;

async function type(text: string) {
  await act(async () => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(sel: HTMLSelectElement, value: string) {
  await act(async () => {
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const mount = () => act(async () => render(<FileTypesControl id="assoc" />, root));

beforeEach(async () => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  saved = [];
  app.settings.value = { ...DEFAULT_SETTINGS };
  (app as { backend: unknown }).backend = { saveSettings: async (p: Partial<Settings>) => void saved.push(p) };
  await mount();
});
afterEach(async () => {
  await flushSettings();
  await act(async () => render(null, root));
  vi.useRealTimers();
});

describe('File type associations (Settings)', () => {
  it('starts empty: no list, a hint, nothing to add yet', () => {
    expect(rows()).toEqual([]);
    expect(q('.se-assoc-list')).toBeNull();
    expect(addBtn().disabled).toBe(true);
    expect(note()).toMatch(/An extension \(ctp/);
    expect(langSelect().value).toBe('');
    const def = settingByKey('files.associations')!;
    expect(def.default).toBeNull();
    expect(isChanged(def, app.settings.value)).toBe(false);
  });

  it('adds *.ctp → PHP from "ctp", shows what it will match, and stores a plain map', async () => {
    await type('ctp');
    expect(note()).toBe('Files ending in .ctp.');
    expect(addBtn().disabled).toBe(true); // no language yet
    await choose(langSelect(), 'php');
    expect(note()).toBe('Files ending in .ctp open as PHP.');
    expect(addBtn().disabled).toBe(false);
    await click(addBtn());
    expect(stored()).toEqual({ '*.ctp': 'php' });
    expect(rows()).toEqual(['*.ctp → php']);
    expect(input().value).toBe('');
    expect(isChanged(settingByKey('files.associations')!, app.settings.value)).toBe(true);
    await flushSettings();
    expect(saved).toEqual([{ 'files.associations': { '*.ctp': 'php' } }]);
  });

  it('offers the editor’s languages: Plain text first, then A→Z, none without a grammar', () => {
    const names = [...langSelect().options].map((o) => o.textContent);
    expect(names.slice(0, 2)).toEqual(['Language…', 'Plain text']);
    const langs = names.slice(2);
    expect(langs).toEqual([...langs].sort((a, b) => a!.localeCompare(b!)));
    for (const n of ['PHP', 'JavaScript', 'HTML', 'Markdown', 'YAML', 'Shell']) expect(langs).toContain(n);
    expect(langs).not.toContain('Mermaid');
  });

  it('Enter adds; a leading dot, a star and upper case are the same extension', async () => {
    await choose(langSelect(), 'html');
    await type('.TPL');
    await act(async () => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(stored()).toEqual({ '*.tpl': 'html' });
    for (const again of ['tpl', '.tpl', '*.TPL']) {
      await type(again);
      expect(note(), again).toBe('*.tpl is already in the list');
      expect(q('.se-assoc-note')!.classList.contains('err')).toBe(true);
      expect(input().getAttribute('aria-invalid')).toBe('true');
      expect(addBtn().disabled).toBe(true);
      await act(async () => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    }
    expect(stored()).toEqual({ '*.tpl': 'html' });
  });

  it('refuses what cannot be a pattern, with the reason', async () => {
    await choose(langSelect(), 'php');
    const cases: Array<[string, RegExp]> = [
      ['src/*.ctp', /Folders are not part/],
      ['a\\b', /Folders are not part/],
      ['*.a*', /Only one \*/],
      ['a*b', /Use \* as/],
      ['ctp, tpl', /One pattern per row/],
      ['[ab]', /Only \* is supported/],
      ['md', /Markdown notes always open as notes/],
      ['*.png', /opens in a viewer/],
      ['x'.repeat(70), /Too long/],
    ];
    for (const [text, why] of cases) {
      await type(text);
      expect(note(), text).toMatch(why);
      expect(addBtn().disabled, text).toBe(true);
      await click(addBtn());
    }
    expect(stored() ?? null).toBeNull();
    await type('   ');
    expect(note()).toMatch(/An extension/); // nothing typed: the hint, not an error
  });

  it('names with a dot and prefixes are taken as written', async () => {
    await choose(langSelect(), 'nginx');
    await type('nginx.conf');
    expect(note()).toBe('Files named nginx.conf open as Nginx.');
    await click(addBtn());
    await choose(langSelect(), 'dockerfile');
    await type('Dockerfile.*');
    expect(note()).toBe('Files starting with dockerfile. open as Dockerfile.');
    await click(addBtn());
    expect(stored()).toEqual({ 'nginx.conf': 'nginx', 'dockerfile.*': 'dockerfile' });
  });

  it('changes a row’s language in place and removes rows; the last one gone stores null', async () => {
    await act(async () => void (app.settings.value = { ...DEFAULT_SETTINGS, 'files.associations': { '*.a': 'php', '*.b': 'php', '*.c': 'json' } }));
    expect(rows()).toEqual(['*.a → php', '*.b → php', '*.c → json']);
    await choose(q<HTMLSelectElement>('[data-pattern="*.b"] select')!, 'html');
    expect(rows()).toEqual(['*.a → php', '*.b → html', '*.c → json']);
    expect(Object.keys(stored() as object)).toEqual(['*.a', '*.b', '*.c']);
    await click(q('[data-pattern="*.a"] button')!);
    await click(q('[data-pattern="*.c"] button')!);
    expect(stored()).toEqual({ '*.b': 'html' });
    await click(q('[data-pattern="*.b"] button')!);
    expect(stored()).toBeNull();
    expect(q('.se-assoc-list')).toBeNull();
    // Reset to default is the same value.
    expect(resetPatch(settingByKey('files.associations')!)).toEqual({ 'files.associations': null });
  });

  it('a hand-edited file: odd rows are not shown, never applied, and survive an edit', async () => {
    const hand = { '*.CTP': 'PHP', '*.z': 'language-of-a-newer-build', 'src/*.x': 'php', '*.n': 42, '*.tw': 'twig' };
    await act(async () => void (app.settings.value = { ...DEFAULT_SETTINGS, 'files.associations': hand }));
    expect(rows()).toEqual(['*.ctp → php', '*.tw → twig']); // twig has no editor grammar: shown as it is
    expect(q('[data-pattern="*.tw"] select')!.textContent).toMatch(/^Twig/);
    await choose(langSelect(), 'json');
    await type('rc');
    await click(addBtn());
    expect(stored()).toEqual({ ...hand, '*.rc': 'json' });
    await click(q('[data-pattern="*.ctp"] button')!);
    expect(stored()).toEqual({ '*.z': 'language-of-a-newer-build', 'src/*.x': 'php', '*.n': 42, '*.tw': 'twig', '*.rc': 'json' });
    for (const junk of [42, 'x', ['*.a'], null]) {
      await act(async () => void (app.settings.value = { ...DEFAULT_SETTINGS, 'files.associations': junk }));
      expect(rows()).toEqual([]);
    }
  });

  it('stops at the maximum', async () => {
    const full = Object.fromEntries(Array.from({ length: MAX_ASSOCIATIONS }, (_, i) => [`*.e${i}`, 'php']));
    await act(async () => void (app.settings.value = { ...DEFAULT_SETTINGS, 'files.associations': full }));
    expect(rows()).toHaveLength(MAX_ASSOCIATIONS);
    expect(input().disabled).toBe(true);
    expect(addBtn().disabled).toBe(true);
    expect(note()).toMatch(new RegExp(`At most ${MAX_ASSOCIATIONS}`));
    await click(q('[data-pattern="*.e0"] button')!);
    expect(input().disabled).toBe(false);
  });

  it('applies live (settings:changed) and asks for one index rebuild once the backend has it', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    let stale = 0;
    const offA = app.events.on('settings:changed', (s) => seen.push(s['files.associations']));
    const offB = app.events.on('index:stale', () => {
      expect(saved.at(-1)).toEqual({ 'files.associations': { '*.a': 'php', '*.b': 'html' } }); // saved first
      stale++;
    });
    setFileAssociation('*.a', 'php');
    setFileAssociation('*.b', 'html');
    expect(seen).toEqual([{ '*.a': 'php' }, { '*.a': 'php', '*.b': 'html' }]);
    expect(fileAssociations()).toEqual([
      { pattern: '*.a', language: 'php' },
      { pattern: '*.b', language: 'html' },
    ]);
    expect(stale).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stale).toBe(1);
    offA();
    offB();
  });
});
