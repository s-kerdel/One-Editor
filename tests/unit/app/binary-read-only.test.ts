// @vitest-environment happy-dom
// A binary file shown as text ("Open as text anyway") is read only:
// - the editor refuses every edit (typing keys, commands, format / replace, reloads, undo) but keeps the
//   cursor, selection, copy and Find; it is a plain code view, never Markdown editing;
// - the shell never marks it dirty (no autosave, no "Save changes?") and never sends its text out;
// - the search index keeps it name-only on every path: doc:changed, doc:saved, file:updated, doc:closed, rebuilds.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { signal } from '@preact/signals';
import { undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { runScopeHandlers, type EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS } from '@shared/api';
import { createEditor } from '../../../src/renderer/editor/index';
import { buildEditorMenu } from '../../../src/renderer/editor/context-menu';
import { app, type DocState, type EditorController } from '../../../src/renderer/app/app';
import { autosaveTimers, noteEdited } from '../../../src/renderer/app/documents';
import { confirmUnsaved } from '../../../src/renderer/app/doc-save';
import { isMarkdownView } from '../../../src/renderer/app/ui';
import { searchClient } from '../../../src/renderer/search/client';

const TEXT = 'PK\u0003\u0004 header �� zebrastripe tail';

const binDoc = (path: string, content: string): DocState => ({ path, saved: content, content, mtime: 1, eol: 'lf', dirty: signal(false), binary: true, asText: { size: content.length, full: true } });
const textDoc = (path: string, content: string): DocState => ({ path, saved: content, content, mtime: 1, eol: 'lf', dirty: signal(false) });

describe('editor: a read-only doc', () => {
  let ed: EditorController;
  let view: EditorView;
  beforeEach(() => {
    document.body.innerHTML = '<div id="host" style="height:400px"></div>';
    ed = createEditor(document.getElementById('host')!);
    ed.applySettings({ ...DEFAULT_SETTINGS });
    view = ed.getView!() as EditorView;
  });

  it('refuses every edit; cursor, selection and keyboard navigation still work', () => {
    ed.open('blob.bin', TEXT, { readOnly: true });
    expect(view.state.readOnly).toBe(true);
    view.dispatch({ changes: { from: 0, insert: 'typed' } }); // any command, widget or keymap
    ed.applyChanges!('blob.bin', [{ from: 0, to: 2, insert: 'X' }]); // format, replace in files
    ed.setContent('blob.bin', 'replaced'); // a minimal-diff reload
    for (const key of ['Enter', 'Tab', 'Backspace', 'Delete']) runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor');
    expect(ed.getContent()).toBe(TEXT);
    expect(undo(view)).toBe(false);
    view.dispatch({ selection: { anchor: 2, head: 5 } });
    expect(ed.getCursor()).toEqual({ line: 0, col: 5, selectionLength: 3 });
    expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true');
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('true'); // the caret stays
  });

  it('Find opens without a replace field', () => {
    ed.open('blob.bin', TEXT, { readOnly: true });
    openSearchPanel(view);
    expect(view.dom.querySelector('.cm-search input[name=search]')).not.toBeNull();
    expect(view.dom.querySelector('.cm-search input[name=replace]')).toBeNull();
  });

  it('stays read only through Load all, a language change and a rename; a normal reopen is editable', () => {
    ed.open('blob.bin', 'first window', { readOnly: true });
    view.dispatch({ selection: { anchor: 3 } });
    ed.setContent('blob.bin', 'first window and the rest', { resetHistory: true }); // Load all
    expect(ed.getContent()).toBe('first window and the rest');
    expect(ed.getCursorOffset!()).toBe(3); // cursor kept
    expect(view.state.readOnly).toBe(true);
    ed.setLanguage!('blob.bin', 'json');
    expect(view.state.readOnly).toBe(true);
    ed.rename('blob.bin', 'renamed.bin');
    expect(view.state.readOnly).toBe(true);
    ed.close('renamed.bin'); // Back to viewer / close tab
    ed.open('renamed.bin', 'abc');
    expect(view.state.readOnly).toBe(false);
    view.dispatch({ changes: { from: 3, insert: 'd' } });
    expect(ed.getContent()).toBe('abcd');
  });

  it('a binary .md is a plain code view, never Markdown editing', () => {
    ed.open('weird.md', '# looks like a heading', { readOnly: true });
    expect(view.dom.classList.contains('se-codefile')).toBe(true);
    expect(view.dom.classList.contains('se-md')).toBe(false);
  });

  it('the context menu offers no editing item', () => {
    ed.open('blob.bin', TEXT, { readOnly: true });
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    const labels = buildEditorMenu(view, { markdown: false }).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Copy', 'Select all']));
    for (const l of ['Cut', 'Paste', 'Paste as plain text', 'Toggle comment', 'Trim trailing whitespace in selection', 'Format document']) expect(labels).not.toContain(l);
  });
});

describe('shell: a binary doc shown as text', () => {
  afterEach(() => {
    app.docs.clear();
    app.settings.value = { ...DEFAULT_SETTINGS };
  });

  it('never turns dirty, never autosaves, never emits doc:changed; closing it asks nothing', async () => {
    app.settings.value = { ...DEFAULT_SETTINGS, autosave: true };
    const doc = binDoc('blob.bin', TEXT);
    app.docs.set(doc.path, doc);
    const seen: string[] = [];
    const off = app.events.on('doc:changed', (p) => seen.push(p));
    noteEdited('blob.bin', `${TEXT} edited`);
    off();
    expect(doc.dirty.value).toBe(false);
    expect(seen).toEqual([]);
    expect(autosaveTimers.has('blob.bin')).toBe(false);
    expect(await confirmUnsaved(['blob.bin'])).toBe(true); // no "Save changes?"
  });

  it('a normal doc still turns dirty (control)', () => {
    app.settings.value = { ...DEFAULT_SETTINGS, autosave: false };
    const doc = textDoc('a.md', 'x');
    app.docs.set(doc.path, doc);
    noteEdited('a.md', 'xy');
    expect(doc.dirty.value).toBe(true);
  });

  it('is never a Markdown view (no reading view, split or Markdown toolbar)', () => {
    app.docs.set('weird.md', binDoc('weird.md', '# heading'));
    app.docs.set('note.md', textDoc('note.md', '# heading'));
    expect(isMarkdownView('weird.md')).toBe(false);
    expect(isMarkdownView('note.md')).toBe(true);
  });
});

describe('search: a binary doc stays name-only', () => {
  const disk: Record<string, { content: string; binary?: boolean }> = {
    'note.md': { content: 'plain note text' },
    'blob.bin': { content: '', binary: true }, // the backend's name-only entry
  };

  beforeAll(async () => {
    (globalThis as any).Worker = undefined; // in-thread search (same SearchHost as the worker)
    app.backend = {
      readAllText: async () => Object.entries(disk).map(([path, f]) => ({ path, mtime: 1, eol: 'lf' as const, ...f })),
      // Defensive: even a read that hands back text for a binary file must not index it.
      readFile: async (path: string) => ({ path, mtime: 1, eol: 'lf' as const, ...(disk[path].binary ? { content: TEXT, binary: true } : disk[path]) }),
    } as any;
    app.workspace.value = { root: '/ws', name: 'ws' };
    searchClient.wire();
    await searchClient.start();
    await searchClient.whenReady();
    app.docs.set('blob.bin', binDoc('blob.bin', TEXT)); // open, shown as text
  });

  const find = async (q: string) => (await searchClient.search(q))!.results.map((r) => r.path);

  it('doc:changed, doc:saved and file:updated never index its text; its name stays findable', async () => {
    app.events.emit('doc:changed', 'blob.bin', TEXT);
    expect(await find('zebrastripe')).toEqual([]);
    app.events.emit('doc:saved', 'blob.bin', TEXT);
    expect(await find('zebrastripe')).toEqual([]);
    app.events.emit('file:updated', 'blob.bin', TEXT);
    expect(await find('zebrastripe')).toEqual([]);
    expect(await find('blob')).toEqual(['blob.bin']);
    expect(await find('plain note')).toEqual(['note.md']);
  });

  it('a rebuild and closing the doc keep it name-only', async () => {
    app.events.emit('workspace:opened', { root: '/ws', name: 'ws' });
    await new Promise((r) => setTimeout(r, 0));
    await searchClient.whenReady();
    expect(await find('zebrastripe')).toEqual([]);
    expect(await find('blob')).toEqual(['blob.bin']);
    app.events.emit('doc:closed', 'blob.bin');
    await new Promise((r) => setTimeout(r, 10));
    expect(await find('zebrastripe')).toEqual([]);
    expect(await find('blob')).toEqual(['blob.bin']);
  });
});
