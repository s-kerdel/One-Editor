// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@preact/signals';
import { EditorSelection } from '@codemirror/state';
import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, type TreeNode } from '@shared/api';
import { app, type DocState } from '../../../src/renderer/app/app';
import { createEditor } from '../../../src/renderer/editor/index';
import { pendingCaretLines, trimForSave } from '../../../src/renderer/whitespace/save';

let view: EditorView;
let focused = false;
const disk = new Map<string, string>();

function setup(path: string, saved: string, settings: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="host" style="height:400px"></div>';
  const ed = createEditor(document.getElementById('host')!);
  app.settings.value = { ...DEFAULT_SETTINGS, ...settings };
  ed.applySettings(app.settings.value);
  app.editor = ed;
  const files = [path, ...disk.keys()];
  app.tree.value = { name: '', path: '', kind: 'dir', children: files.map((p) => ({ name: p, path: p, kind: 'file' })) } as TreeNode;
  app.backend = { readFile: async (p: string) => ({ path: p, content: disk.get(p) ?? '', mtime: 1, eol: 'lf' }) } as never;
  const doc: DocState = { path, saved, content: saved, mtime: 1, eol: 'lf', dirty: signal(false) };
  app.docs.clear();
  app.docs.set(path, doc);
  ed.open(path, saved);
  app.activePath.value = path;
  view = ed.getView!() as EditorView;
  focused = false;
  Object.defineProperty(view, 'hasFocus', { get: () => focused, configurable: true });
  pendingCaretLines.clear();
}
const text = () => view.state.doc.toString();
const edit = (from: number, insert: string, to = from) => view.dispatch({ changes: { from, to, insert }, userEvent: 'input.type' });
const save = async (explicit: boolean) => trimForSave(app.activePath.value!, text(), { explicit });

beforeEach(() => disk.clear());

describe('trim on save', () => {
  it("'changed' (default): only edited lines lose trailing spaces — untouched lines keep theirs", async () => {
    setup('a.ts', 'one  \ntwo  \nthree  ');
    edit(9, '!'); // "two!  "
    expect(await save(true)).toBe('one  \ntwo!\nthree  ');
    expect(text()).toBe('one  \ntwo!\nthree  ');
  });

  it('multi-cursor edits: every touched line, nothing else', async () => {
    setup('a.ts', 'a  \nb  \nc  \nd  ');
    view.dispatch({ changes: [{ from: 1, insert: 'x' }, { from: 9, insert: 'y' }], userEvent: 'input.type' });
    expect(await save(true)).toBe('ax\nb  \ncy\nd  ');
  });

  it('after undo back to the saved text nothing changes; redo makes the line "edited" again', async () => {
    setup('a.ts', 'keep  \nme  ');
    edit(4, 'Z');
    undo(view);
    expect(await save(true)).toBe('keep  \nme  ');
    redo(view);
    expect(await save(true)).toBe('keepZ\nme  ');
  });

  it("the trim is no undo step of its own: Ctrl+Z after saving undoes the edit", async () => {
    setup('a.ts', 'alpha\nbeta');
    edit(5, ' typed  ');
    expect(await save(true)).toBe('alpha typed\nbeta');
    undo(view);
    expect(text()).toBe('alpha\nbeta');
  });

  it("'all' trims every line, 'off' nothing; markdown keeps hard breaks unless switched off", async () => {
    setup('a.ts', 'x  \ny  ', { 'editor.trimOnSave.code': 'all' });
    expect(await save(true)).toBe('x\ny');
    setup('a.ts', 'x  \ny  ', { 'editor.trimOnSave.code': 'off' });
    edit(0, 'q');
    expect(await save(true)).toBe('qx  \ny  ');
    setup('n.md', 'para  \nnext  \n\n```sh\nls  \n```', { 'editor.trimOnSave.markdown': 'all' });
    expect(await save(true)).toBe('para  \nnext\n\n```sh\nls\n```');
    setup('n.md', 'para  \nnext', { 'editor.trimOnSave.markdown': 'all', 'editor.trimOnSave.keepMarkdownBreaks': false });
    expect(await save(true)).toBe('para\nnext');
  });

  it('autosave spares the line the caret is on; it is trimmed once the caret leaves', async () => {
    setup('a.ts', 'first\nsecond');
    edit(5, '   '); // typing spaces at the end of line 1…
    edit(15, '  '); // …and on line 2, where the caret now is
    view.dispatch({ selection: EditorSelection.cursor(text().length) });
    focused = true;
    expect(await save(false)).toBe('first\nsecond  '); // autosave: caret line kept
    expect(pendingCaretLines.get('a.ts')).toEqual(new Set([1]));
    expect(await save(true)).toBe('first\nsecond'); // an explicit save trims it
    // Autosave again, then the caret leaves the line.
    setup('a.ts', 'first\nsecond');
    edit(12, ' x  ');
    view.dispatch({ selection: EditorSelection.cursor(text().length) });
    focused = true;
    await save(false);
    expect(text()).toBe('first\nsecond x  ');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    await Promise.resolve();
    expect(text()).toBe('first\nsecond x');
  });

  it('.editorconfig trim_trailing_whitespace wins over the setting', async () => {
    disk.set('.editorconfig', 'root = true\n[*]\ntrim_trailing_whitespace = true\n[*.md]\ntrim_trailing_whitespace = false\n');
    setup('src/a.ts', 'x  \ny  ', { 'editor.trimOnSave.code': 'off' });
    expect(await save(true)).toBe('x\ny');
    setup('n.md', 'x  ');
    edit(0, 'q');
    expect(await save(true)).toBe('qx  ');
  });
});
