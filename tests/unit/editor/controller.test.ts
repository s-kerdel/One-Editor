// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS } from '@shared/api';
import { createEditor } from '../../../src/renderer/editor/index';
import type { EditorController } from '../../../src/renderer/app/app';
import { highlightQueryField } from '../../../src/renderer/editor/search-highlight';

let ed: EditorController;
let view: EditorView;
beforeEach(() => {
  document.body.innerHTML = '<div id="host" style="height:400px"></div>';
  ed = createEditor(document.getElementById('host')!);
  ed.applySettings({ ...DEFAULT_SETTINGS });
  view = ed.getView!() as EditorView;
});

const setCursor = (pos: number) => view.dispatch({ selection: { anchor: pos } });

describe('EditorController', () => {
  it('keeps a separate state (content + undo history) per tab', () => {
    ed.open('a.md', 'alpha');
    view.dispatch({ changes: { from: 5, insert: '!' } });
    ed.open('b.ts', 'const b = 1;');
    expect(ed.getContent()).toBe('const b = 1;');
    expect(ed.getContent('a.md')).toBe('alpha!');
    ed.open('a.md', 'ignored: state exists');
    expect(ed.getContent()).toBe('alpha!');
    undo(view);
    expect(ed.getContent()).toBe('alpha');
  });

  it('marks markdown vs code files and live/source modes on the editor root', () => {
    ed.open('n.md', '# hi');
    expect(view.dom.classList.contains('se-editor')).toBe(true);
    expect(view.dom.classList.contains('se-md')).toBe(true);
    expect(view.dom.classList.contains('se-live')).toBe(true);
    ed.setViewMode('source');
    expect(view.dom.classList.contains('se-source')).toBe(true);
    ed.setViewMode('split');
    expect(view.dom.classList.contains('se-source')).toBe(true);
    ed.open('x.php', '<?php echo 1;');
    expect(view.dom.classList.contains('se-codefile')).toBe(true);
    ed.setViewMode('live');
    ed.open('n.md', '');
    expect(view.dom.classList.contains('se-live')).toBe(true);
  });

  it('setContent applies a minimal diff so the cursor stays near its position', () => {
    ed.open('a.md', 'line one\nline two\nline three');
    setCursor(15); // inside "line two"
    ed.setContent('a.md', 'NEW line one\nline two\nline three');
    expect(ed.getContent()).toBe('NEW line one\nline two\nline three');
    expect(ed.getCursorOffset!()).toBe(19);
    ed.setContent('a.md', 'NEW line one\nline two\nline three\nappended');
    expect(ed.getCursorOffset!()).toBe(19);
    undo(view);
    expect(ed.getContent()).toBe('NEW line one\nline two\nline three');
  });

  it('setContent with resetHistory drops undo history', () => {
    ed.open('a.md', 'one');
    view.dispatch({ changes: { from: 3, insert: ' two' } });
    ed.setContent('a.md', 'fresh', { resetHistory: true });
    expect(ed.getContent()).toBe('fresh');
    expect(undo(view)).toBe(false);
  });

  it('setContent / applyChanges on a background tab notify onChange', () => {
    const seen: Array<[string, string]> = [];
    ed.onChange((p, c) => seen.push([p, c]));
    ed.open('a.md', 'aaa');
    ed.open('b.md', 'bbb');
    ed.setContent('a.md', 'aaa2');
    ed.applyChanges!('a.md', [{ from: 0, to: 1, insert: 'X' }]);
    expect(ed.getContent('a.md')).toBe('Xaa2');
    expect(seen).toEqual([
      ['a.md', 'aaa2'],
      ['a.md', 'Xaa2'],
    ]);
  });

  it('applyChanges keeps undo granularity and sets the selection', () => {
    ed.open('f.ts', 'let  a=1');
    ed.applyChanges!('f.ts', [{ from: 3, to: 5, insert: ' ' }, { from: 6, to: 7, insert: ' = ' }], { selection: { anchor: 2 } });
    expect(ed.getContent()).toBe('let a = 1');
    expect(ed.getCursorOffset!()).toBe(2);
    undo(view);
    expect(ed.getContent()).toBe('let  a=1');
  });

  it('rename moves the state (and switches language kind when needed)', () => {
    ed.open('a.txt', '# title');
    view.dispatch({ changes: { from: 7, insert: '!' } });
    ed.rename('a.txt', 'a.md');
    expect(ed.getContent('a.md')).toBe('# title!');
    expect(ed.getContent('a.txt')).toBeUndefined();
    expect(view.dom.classList.contains('se-md')).toBe(true);
  });

  it('reveal selects the target range; getCursor reports line/col', () => {
    ed.open('a.md', 'first\nsecond line\nthird');
    ed.reveal({ line: 1, col: 2, length: 4 });
    expect(ed.getCursor()).toEqual({ line: 1, col: 6, selectionLength: 4 });
  });

  it('close drops the state', () => {
    ed.open('a.md', 'x');
    ed.close('a.md');
    expect(ed.getContent('a.md')).toBeUndefined();
    expect(ed.getContent()).toBeUndefined();
  });

  it('highlightSearch marks matches in the active editor', () => {
    ed.open('a.md', 'foo bar foo');
    ed.highlightSearch!({ search: 'foo' });
    expect(view.state.field(highlightQueryField)?.search).toBe('foo');
    // carried over to other tabs when they're shown
    ed.open('b.md', 'foo');
    expect(view.state.field(highlightQueryField)?.search).toBe('foo');
    ed.highlightSearch!(null);
    expect(view.state.field(highlightQueryField)).toBeNull();
  });
});

describe('markdown comment toggle', () => {
  it('Mod-/ wraps the line in Obsidian %% comments', async () => {
    const { toggleComment } = await import('@codemirror/commands');
    ed.open('c.md', 'secret line');
    view.dispatch({ selection: { anchor: 3 } });
    toggleComment(view);
    expect(ed.getContent()).toBe('%% secret line %%');
  });

  it('line numbers for markdown only in source/split (markdownLineNumbers); code files always', () => {
    const gutter = () => !!view.dom.querySelector('.cm-lineNumbers');
    ed.open('n.md', '# hi\ntext');
    expect(gutter()).toBe(false);
    ed.setViewMode('source');
    expect(gutter()).toBe(true);
    ed.setViewMode('split');
    expect(gutter()).toBe(true);
    ed.applySettings({ ...DEFAULT_SETTINGS, viewMode: 'split', markdownLineNumbers: false });
    expect(gutter()).toBe(false);
    ed.open('x.ts', 'let a = 1;');
    expect(gutter()).toBe(true);
    ed.applySettings({ ...DEFAULT_SETTINGS, viewMode: 'live', markdownLineNumbers: true });
    ed.open('n.md', '');
    expect(gutter()).toBe(false);
  });

  it('formatting toolbar only for markdown in live mode, and only when enabled', () => {
    const bar = () => !!view.dom.querySelector('.se-fmtbar');
    ed.open('n.md', 'text');
    expect(bar()).toBe(true);
    ed.setViewMode('source');
    expect(bar()).toBe(false);
    ed.setViewMode('live');
    ed.applySettings({ ...DEFAULT_SETTINGS, formatToolbar: false });
    expect(bar()).toBe(false);
    ed.applySettings({ ...DEFAULT_SETTINGS });
    expect(bar()).toBe(true);
    ed.open('x.ts', 'let a = 1;');
    expect(bar()).toBe(false);
  });

  it('setLanguage: markdown ↔ code view in place (content, selection, undo kept), events, getLanguage', () => {
    const events: string[] = [];
    ed.onLanguageChange!((p) => events.push(p));
    ed.open('n.md', 'alpha');
    view.dispatch({ changes: { from: 5, insert: ' beta' }, selection: { anchor: 2 } });
    expect(ed.getLanguage!()).toEqual({ id: 'markdown', name: 'Markdown', auto: true });
    ed.setLanguage!('n.md', 'php');
    expect(view.dom.classList.contains('se-codefile')).toBe(true);
    expect(view.dom.classList.contains('se-live')).toBe(false);
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(ed.getContent()).toBe('alpha beta');
    expect(view.state.selection.main.head).toBe(2);
    expect(ed.getLanguage!('n.md')).toEqual({ id: 'php', name: 'PHP', auto: false });
    ed.setLanguage!('n.md', 'php'); // no-op
    expect(events).toEqual(['n.md']);
    ed.setLanguage!('n.md', null);
    expect(view.dom.classList.contains('se-live')).toBe(true);
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeNull();
    expect(events).toEqual(['n.md', 'n.md']);
    undo(view);
    expect(ed.getContent()).toBe('alpha');
    // Choosing the file's own language means "auto"; overrides follow renames and die with the tab.
    ed.open('x.ts', 'let a');
    ed.setLanguage!('x.ts', 'typescript');
    expect(ed.getLanguage!('x.ts')!.auto).toBe(true);
    ed.setLanguage!('x.ts', 'text');
    expect(ed.getLanguage!('x.ts')).toEqual({ id: 'text', name: 'Plain text', auto: false });
    ed.rename('x.ts', 'y.ts');
    expect(ed.getLanguage!('y.ts')!.id).toBe('text');
    ed.close('y.ts');
    expect(ed.getLanguage!('y.ts')!.auto).toBe(true);
  });

  it('setLanguage on a background tab updates that tab only', () => {
    ed.open('a.md', 'aaa');
    ed.open('b.md', 'bbb');
    ed.setLanguage!('a.md', 'yaml');
    expect(view.dom.classList.contains('se-live')).toBe(true); // b.md still markdown
    ed.open('a.md', 'ignored');
    expect(view.dom.classList.contains('se-codefile')).toBe(true);
    expect(ed.getContent()).toBe('aaa');
  });
});
