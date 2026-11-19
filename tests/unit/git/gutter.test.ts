// @vitest-environment happy-dom
// The change gutter on a real EditorView: HEAD base loading, live hunks, peek + revert (one undo step).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import { gitGutter, gitHunks, nextChange, peekChangeAtCursor, previousChange, revertChangeAtCursor, type GitGutterSource } from '../../../src/renderer/git/gutter';

const BASE = 'one\ntwo\nthree\nfour\nfive\n';

function fakeSource(initial: Record<string, string | null>) {
  const texts = { ...initial };
  let key: Record<string, string | null> = Object.fromEntries(Object.keys(texts).map((p) => [p, texts[p] === null ? null : 'k1']));
  const subs = new Set<() => void>();
  let loads = 0;
  const source: GitGutterSource = {
    key: (p) => key[p] ?? null,
    load: async (p) => (loads++, texts[p] ?? null),
    subscribe: (cb) => (subs.add(cb), () => subs.delete(cb)),
  };
  return {
    source,
    get loads() {
      return loads;
    },
    /** A new commit: new content under a new key. */
    commit(p: string, text: string | null, k = 'k2') {
      texts[p] = text;
      key = { ...key, [p]: text === null ? null : k };
      subs.forEach((cb) => cb());
    },
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
let view: EditorView;
afterEach(() => view?.destroy());

function mount(doc: string, src: GitGutterSource, path = 'a.md') {
  document.body.innerHTML = '<div id="host" style="height:400px"></div>';
  view = new EditorView({
    parent: document.getElementById('host')!,
    state: EditorState.create({ doc, extensions: [history(), gitGutter({ source: src, path: () => path, delay: 5 })] }),
  });
  return view;
}
const kinds = () => gitHunks(view.state).map((h) => `${h.kind}@${h.newStart}+${h.newCount}`);
const setCursorLine = (n: number) => view.dispatch({ selection: { anchor: view.state.doc.line(n).from } });

describe('git gutter', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('loads the HEAD text and marks added / modified / deleted lines', async () => {
    const f = fakeSource({ 'a.md': BASE });
    mount('one\nTWO\nthree\nfive\nsix\n', f.source);
    await tick();
    expect(kinds()).toEqual(['modified@1+1', 'deleted@3+0', 'added@4+1']);
    const bars = [...view.dom.querySelectorAll('.se-git-gutter .se-git-bar')].map((b) => b.className.replace('se-git-bar ', ''));
    expect(bars).toEqual(['se-git-modified', 'se-git-deleted', 'se-git-added']);
  });

  it('follows typing (debounced) and clears when the buffer matches HEAD again', async () => {
    const f = fakeSource({ 'a.md': BASE });
    mount(BASE, f.source);
    await tick();
    expect(kinds()).toEqual([]);
    view.dispatch({ changes: { from: 0, insert: 'zero\n' } });
    await tick();
    expect(kinds()).toEqual(['added@0+1']);
    view.dispatch({ changes: { from: 0, to: 5 } });
    await tick();
    expect(kinds()).toEqual([]);
  });

  it('no HEAD version (untracked) → no bars; a new commit reloads the base', async () => {
    const f = fakeSource({ 'a.md': null });
    mount('new file\n', f.source);
    await tick();
    expect(kinds()).toEqual([]);
    f.commit('a.md', 'old file\n');
    await tick();
    expect(kinds()).toEqual(['modified@0+1']);
    f.commit('a.md', 'new file\n', 'k3'); // committed what is in the buffer
    await tick();
    expect(kinds()).toEqual([]);
  });

  it('peek shows the old lines; revert applies as ONE undo step', async () => {
    const f = fakeSource({ 'a.md': BASE });
    mount('one\nTWO\n2b\nthree\nfour\nfive\n', f.source);
    await tick();
    setCursorLine(2);
    expect(peekChangeAtCursor(view)).toBe(true);
    const peek = view.dom.querySelector('.se-git-peek')!;
    expect(peek.querySelector('.se-git-peek-label')!.textContent).toBe('1 line changed');
    expect([...peek.querySelectorAll('.se-git-peek-line')].map((l) => l.textContent)).toEqual(['two']);
    (peek.querySelector('.se-git-peek-btn.revert') as HTMLButtonElement).click();
    expect(view.state.doc.toString()).toBe(BASE);
    expect(view.dom.querySelector('.se-git-peek')).toBeNull();
    expect(kinds()).toEqual([]);
    undo(view);
    expect(view.state.doc.toString()).toBe('one\nTWO\n2b\nthree\nfour\nfive\n');
    redo(view);
    expect(view.state.doc.toString()).toBe(BASE);
  });

  it('a click on a bar toggles the peek', async () => {
    const f = fakeSource({ 'a.md': BASE });
    // happy-dom has no layout: CodeMirror maps every gutter click to line 1, so the change sits there.
    mount('zero\none\ntwo\nthree\nfour\nfive\n', f.source);
    await tick();
    const el = view.dom.querySelector('.se-git-gutter .se-git-bar')!.parentElement as HTMLElement;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(view.dom.querySelector('.se-git-peek-label')?.textContent).toBe('1 line added');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(view.dom.querySelector('.se-git-peek')).toBeNull();
  });

  it('reverts deletions at the top and at the end', async () => {
    const f = fakeSource({ 'a.md': 'a\nb\nc' });
    mount('b\nc', f.source);
    await tick();
    setCursorLine(1);
    expect(revertChangeAtCursor(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('a\nb\nc');
    view.dispatch({ changes: { from: 3, to: 5 } }); // drop "\nc"
    await tick();
    setCursorLine(2);
    expect(revertChangeAtCursor(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('a\nb\nc');
  });

  it('next / previous change wrap around', async () => {
    const f = fakeSource({ 'a.md': BASE });
    mount('ONE\ntwo\nthree\nFOUR\nfive\n', f.source);
    await tick();
    setCursorLine(2);
    nextChange(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    nextChange(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
    previousChange(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
  });

  it('read-only docs cannot be reverted', async () => {
    const f = fakeSource({ 'a.md': BASE });
    document.body.innerHTML = '<div id="host"></div>';
    view = new EditorView({
      parent: document.getElementById('host')!,
      state: EditorState.create({ doc: 'ONE\ntwo\nthree\nfour\nfive\n', extensions: [EditorState.readOnly.of(true), gitGutter({ source: f.source, path: () => 'a.md', delay: 5 })] }),
    });
    await tick();
    setCursorLine(1);
    expect(revertChangeAtCursor(view)).toBe(false);
    peekChangeAtCursor(view);
    expect((view.dom.querySelector('.se-git-peek-btn.revert') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps its base across setState (tab switches) without reloading', async () => {
    const f = fakeSource({ 'a.md': BASE });
    mount('ONE\ntwo\nthree\nfour\nfive\n', f.source);
    await tick();
    const loads = f.loads;
    const saved = view.state;
    view.setState(EditorState.create({ doc: 'other' }));
    view.setState(saved);
    await tick();
    expect(f.loads).toBe(loads);
    expect(kinds()).toEqual(['modified@0+1']);
  });
});
