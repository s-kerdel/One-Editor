// @vitest-environment happy-dom
// One route into a file's diff (pane row and "Diff with last commit" get the same commit boxes), and
// compare: which sides take a block, the text an applied block leaves behind (both directions), the
// controls per direction, and undo for the left side of a unified compare.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { signal } from '@preact/signals';
import { ChangeSet, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Chunk, getOriginalDoc } from '@codemirror/merge';
import type { GitEntry, GitFileHunks, GitStatus } from '@shared/git';
import { app, type DocState, type EditorController } from '../../../src/renderer/app/app';
import { applyChange, blockAt, compareTargets, editableSide, SideHistory, WHITESPACE_OFF } from '../../../src/renderer/git/diff-edit';
import { compareTexts } from '../../../src/renderer/git/compare-diff';
import { DiffView, type DiffViewProps } from '../../../src/renderer/git/DiffView';
import { GitStore } from '../../../src/renderer/git/store';
import { openFileDiff } from '../../../src/renderer/git/diff-open';

const OID = 'c'.repeat(40);
const text = (s: string) => Text.of(s.split('\n'));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const openDoc = (path: string, content: string, saved = content) => app.docs.set(path, { path, saved, content, mtime: 0, eol: 'lf', dirty: signal(content !== saved) } as DocState);

afterEach(() => {
  render(null, document.getElementById('h') ?? document.body);
  app.overlay.value = null;
  app.docs.clear();
  app.editor = null;
  vi.restoreAllMocks();
});

// ---- one route, same boxes ---------------------------------------------------------------------------
describe('openFileDiff: the pane row and "Diff with last commit" share the staging route', () => {
  const entry: GitEntry = { path: 'notes/a.md', state: 'modified', unstaged: true };
  async function store(status: Partial<GitStatus> | null = {}) {
    const s = new GitStore({
      gitStatus: async () =>
        status
          ? ({ ok: true, branch: { head: 'main', oid: OID, detached: false, upstream: null, ahead: 0, behind: 0 }, entries: [entry, { path: 'new.md', state: 'untracked' }, { path: 'both.md', state: 'conflicted' }], prefix: '', ms: 1, ...status } as GitStatus)
          : { ok: false, reason: 'untrusted', repoLikely: true },
      gitHeadFile: async (_p, rev) => ({ content: 'one\ntwo\n', oid: rev ?? OID }),
    });
    await s.refreshNow();
    return s;
  }
  /** A backend that answers `hunks` with `reply` and records every git call. */
  function backend(reply: GitFileHunks) {
    const git = vi.fn(async (op: string) => (op === 'hunks' ? reply : { ok: true }));
    (app as unknown as { backend: unknown }).backend = { git, readFile: async () => ({ content: 'one\nTWO\n', binary: false }) };
    return git;
  }
  const shown = (): Record<string, any> => (app.overlay.value as unknown as () => { props: Record<string, any> })().props;
  const blocks: GitFileHunks = { mode: 'hunks', head: 'one\ntwo\n', work: 'one\nTWO\n', hunks: [{ a0: 1, a1: 2, b0: 1, b1: 2, state: 'unstaged' }] };

  it.each([
    ['Diff with last commit (menu, palette, status bar)', undefined],
    ['a click on the Source control row', entry],
  ])('%s: a box per block and the file box, on the editable working copy', async (_name, row) => {
    const git = backend(blocks);
    expect(await openFileDiff(await store(), 'notes/a.md', row)).toBe(true);
    const p = shown();
    expect(git).toHaveBeenCalledWith('hunks', 'notes/a.md', null);
    expect(p.base).toBe('one\ntwo\n');
    expect(p.current).toBe('one\nTWO\n');
    expect(p.editable).toBe(true);
    expect(p.staging.hunks.value).toHaveLength(1);
    expect(p.staging.file.value).toBe('off'); // the file's own box, from the status
    expect(p.baseLabel).toBe('Last commit (ccccccc)');
  });

  it('both ways show the same view', async () => {
    backend(blocks);
    const s = await store();
    await openFileDiff(s, 'notes/a.md');
    const { staging: _a, ...menu } = shown();
    await openFileDiff(s, 'notes/a.md', entry);
    const { staging: _b, ...pane } = shown();
    expect(menu).toEqual(pane);
  });

  it('a file git cannot split (binary, filter…): the whole-file box only, with the reason', async () => {
    backend({ mode: 'file', reason: 'filter' });
    expect(await openFileDiff(await store(), 'notes/a.md')).toBe(true);
    expect(shown().staging.hunks.value).toBeNull();
    expect(shown().staging.note).toContain('whole file only');
    expect(shown().staging.file.value).toBe('off');
  });

  it('unsaved edits: they are shown, blocks come with the save (the box saves first)', async () => {
    backend(blocks);
    openDoc('notes/a.md', 'one\nTWO\nthree\n', 'one\nTWO\n');
    await openFileDiff(await store(), 'notes/a.md');
    expect(shown().current).toBe('one\nTWO\nthree\n');
    expect(shown().staging.note).toBe('blocks to pick appear once saved');
  });

  it('only unsaved edits (git lists no change yet): still the staging view, blocks once saved', async () => {
    const git = backend({ mode: 'file', reason: 'unchanged' });
    openDoc('clean.md', 'one\ntwo\nthree\n', 'one\ntwo\n');
    expect(await openFileDiff(await store(), 'clean.md')).toBe(true);
    expect(git).toHaveBeenCalledWith('hunks', 'clean.md', null);
    expect(shown().staging.note).toBe('blocks to pick appear once saved');
    expect(shown().staging.file.value).toBeNull(); // no status entry yet: no file box
    expect(shown().editable).toBe(true);
  });

  it('a conflicted file: the plain diff, no boxes', async () => {
    const git = backend(blocks);
    expect(await openFileDiff(await store(), 'both.md')).toBe(true);
    expect(shown().staging).toBeUndefined();
    expect(git).not.toHaveBeenCalled();
  });

  it('not trusted / no repository: a toast and no git at all, from either entry point', async () => {
    const git = backend(blocks);
    const toast = vi.spyOn(app, 'toast').mockImplementation(() => 0);
    const s = await store(null);
    expect(await openFileDiff(s, 'notes/a.md')).toBe(false);
    expect(await openFileDiff(s, 'notes/a.md', entry)).toBe(false);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[0][0]).toContain('not available');
    expect(git).not.toHaveBeenCalled();
    expect(app.overlay.value).toBeNull();
  });

  it('"Diff with last commit" on a file that is not in the last commit: a toast, no git call', async () => {
    const git = backend(blocks);
    const toast = vi.spyOn(app, 'toast').mockImplementation(() => 0);
    expect(await openFileDiff(await store({ branch: { head: 'main', oid: null, detached: false, upstream: null, ahead: 0, behind: 0 } }), 'notes/a.md')).toBe(false);
    expect(toast.mock.calls[0][0]).toContain('no commit yet');
    expect(git).not.toHaveBeenCalled();
  });
});

// ---- who takes a block ------------------------------------------------------------------------------
describe('compareTargets: only a workspace file is ever a target', () => {
  const file = (path: string) => ({ path, whole: true, live: true });
  const clipboard = { whole: false, live: false };
  const selection = { path: 'a.md', whole: false, live: false };
  const snapshot = { path: 'a.md', whole: true, live: false }; // remembered, the file moved on since

  it('two workspace files: both ways', () => {
    expect(compareTargets(file('a.md'), file('b.md'), false)).toEqual({ a: true, b: true });
  });

  it('a read-only source (clipboard, selection, remembered text) is never a target, on either side', () => {
    for (const ro of [clipboard, selection, snapshot]) {
      expect(compareTargets(ro, file('b.md'), false)).toEqual({ a: false, b: true });
      expect(compareTargets(file('b.md'), ro, false)).toEqual({ a: true, b: false });
      expect(compareTargets(ro, ro, false)).toEqual({ a: false, b: false });
    }
  });

  it('the same file on both sides is one document: only the right side takes text', () => {
    expect(compareTargets(file('a.md'), file('a.md'), false)).toEqual({ a: false, b: true });
  });

  it('ignore whitespace: the sides are known, but switched off with the reason', () => {
    expect(compareTargets(file('a.md'), clipboard, true)).toEqual({ a: true, b: false, off: WHITESPACE_OFF });
    expect(compareTargets(clipboard, selection, true)).toEqual({ a: false, b: false }); // nothing to switch off
    expect(editableSide({ kind: 'compare', path: 'a.md', whole: true, live: true, ignoreWhitespace: true })).toBeNull();
  });

  it('git diffs are untouched by this: HEAD and commits never take text', () => {
    expect(editableSide({ kind: 'commit' })).toBeNull();
    expect(editableSide({ kind: 'working', text: true })).toBe('b');
  });
});

// ---- the text an applied block leaves ---------------------------------------------------------------
describe('applyChange: a block to the other side, both directions', () => {
  /** Applies block `i` of A ↔ B to side `to` and returns that side's new text. */
  function applied(A: string, B: string, i: number, to: 'a' | 'b'): string {
    const [a, b] = [text(A), text(B)];
    const c = Chunk.build(a, b)[i];
    const e = applyChange(c, to, a, b);
    const t = to === 'a' ? A : B;
    return t.slice(0, e.from) + e.insert + t.slice(e.to);
  }
  const A = 'one\ntwo\nthree\nfour\nfive\nsix\n';
  const B = 'ONE\ntwo\nthree\nfour\nfive\nSIX\nseven\n';

  it('a block in the middle: only its lines move', () => {
    const X = 'one\ntwo\nTHREE\nextra\nfour\nfive\nsix\n';
    expect(applied(A, X, 0, 'b')).toBe(A);
    expect(applied(A, X, 0, 'a')).toBe(X);
  });

  it('a block at the start of the file', () => {
    expect(applied(A, B, 0, 'b')).toBe('one\ntwo\nthree\nfour\nfive\nSIX\nseven\n');
    expect(applied(A, B, 0, 'a')).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\n');
  });

  it('a block at the end of the file (changed + added lines)', () => {
    expect(applied(A, B, 1, 'b')).toBe('ONE\ntwo\nthree\nfour\nfive\nsix\n');
    expect(applied(A, B, 1, 'a')).toBe('one\ntwo\nthree\nfour\nfive\nSIX\nseven\n');
  });

  it('lines only one side has: added there, removed here', () => {
    const more = 'zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n';
    expect(Chunk.build(text(A), text(more))).toHaveLength(2);
    expect(applied(A, more, 0, 'a')).toBe('zero\none\ntwo\nthree\nfour\nfive\nsix\n');
    expect(applied(A, more, 0, 'b')).toBe('one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    expect(applied(A, more, 1, 'a')).toBe('one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    expect(applied(A, more, 1, 'b')).toBe('zero\none\ntwo\nthree\nfour\nfive\nsix\n');
  });

  it('no newline at the end of the file', () => {
    const noEol = 'one\ntwo\nthree\nfour\nfive\nSIX';
    // The missing newline is part of the difference: the block takes it along, the sides end up equal.
    expect(applied(A, noEol, 0, 'a')).toBe(noEol);
    expect(applied(A, noEol, 0, 'b')).toBe(A);
    const both = 'one\ntwo\nthree\nfour\nfive\nsix\nlast';
    expect(applied(noEol, both, 0, 'a')).toBe(both);
    expect(applied(noEol, both, 0, 'b')).toBe(noEol);
  });

  it('applying every block makes the sides equal, whichever way', () => {
    for (const to of ['a', 'b'] as const) {
      let [x, y] = [A, B];
      for (let n = Chunk.build(text(x), text(y)).length; n > 0; n--) {
        const t = applied(x, y, 0, to);
        if (to === 'a') x = t;
        else y = t;
      }
      expect(x).toBe(y);
      expect(x).toBe(to === 'a' ? B : A);
    }
  });

  it('blockAt finds the block from either side', () => {
    const chunks = Chunk.build(text(A), text(B));
    expect(blockAt(chunks, 1, 'a')).toBe(chunks[0]);
    expect(blockAt(chunks, A.indexOf('six'), 'a')).toBe(chunks[1]);
    expect(blockAt(chunks, B.indexOf('seven'), 'b')).toBe(chunks[1]);
    expect(blockAt(chunks, A.indexOf('three'), 'a')).toBeNull();
  });
});

describe('compareTexts: what the view shows of each source', () => {
  it('CRLF (a Windows clipboard) becomes LF: an applied block brings no \\r into the document', () => {
    const [a, b] = compareTexts({ text: 'one\r\nTWO\r\n', whole: false }, { text: 'one\ntwo\n', whole: true });
    expect(a).toBe('one\nTWO\n');
    const c = Chunk.build(text(a), text(b))[0];
    const e = applyChange(c, 'b', text(a), text(b));
    expect(b.slice(0, e.from) + e.insert + b.slice(e.to)).toBe('one\nTWO\n');
  });

  it('a piece of text gets a final newline; a whole file stays as it is (it must equal its document)', () => {
    expect(compareTexts({ text: 'x', whole: false }, { text: 'y', whole: false })).toEqual(['x\n', 'y\n']);
    expect(compareTexts({ text: 'x', whole: true }, { text: 'y\n', whole: true })).toEqual(['x', 'y\n']);
  });

  it('a piece compared with a whole file ends the way the file does (no noisy last line)', () => {
    expect(compareTexts({ text: 'x', whole: false }, { text: 'x\n', whole: true })).toEqual(['x\n', 'x\n']);
    expect(compareTexts({ text: 'x\n', whole: false }, { text: 'x', whole: true })).toEqual(['x', 'x']);
    expect(compareTexts({ text: 'x', whole: true }, { text: 'x\r\n', whole: false })).toEqual(['x', 'x']);
    expect(compareTexts({ text: '', whole: true }, { text: 'x', whole: false })).toEqual(['', 'x\n']);
  });
});

describe('SideHistory: undo for the left side of a unified compare, in turn with the editor', () => {
  const ch = (insert: string) => ChangeSet.of({ from: 0, insert }, 0);

  it('the last thing done is undone first', () => {
    const h = new SideHistory();
    h.record(undefined, ch('a'), { undo: 2, redo: 0 }); // applied when the editor had 2 steps
    expect(h.take('undo', 3)).toBeNull(); // the editor has a newer step: it goes first
    const back = h.take('undo', 2);
    expect(back).not.toBeNull();
    expect(h.take('undo', 2)).toBeNull();
    h.record('undo', ch('b'), { undo: 2, redo: 1 });
    expect(h.take('redo', 2)).toBeNull(); // the editor undid something after it: that comes back first
    expect(h.take('redo', 1)).not.toBeNull();
  });

  it('a new change drops what was undone; a change from outside drops everything', () => {
    const h = new SideHistory();
    h.record('undo', ch('a'), { undo: 0, redo: 0 });
    h.record(undefined, ch('b'), { undo: 0, redo: 0 });
    expect(h.take('redo', 0)).toBeNull();
    h.clear();
    expect(h.take('undo', 0)).toBeNull();
  });
});

// ---- the view ------------------------------------------------------------------------------------------
const host = () => {
  document.body.innerHTML = '<div id="h"></div>';
  return document.getElementById('h')!;
};
function fakeEditor(docs: Record<string, string>) {
  const ed = {
    getContent: (p?: string) => (p ? docs[p] : undefined),
    setContent(p: string, t: string) {
      docs[p] = t;
      app.docs.get(p)!.content = t;
      app.docs.get(p)!.dirty.value = t !== app.docs.get(p)!.saved;
      app.events.emit('doc:changed', p, t);
    },
    applyChanges(p: string, changes: Array<{ from: number; to: number; insert: string }>) {
      let t = docs[p];
      for (const c of [...changes].sort((x, y) => y.from - x.from)) t = t.slice(0, c.from) + c.insert + t.slice(c.to);
      ed.setContent(p, t);
    },
    focus() {},
  };
  return { ed: ed as unknown as EditorController, docs };
}
const L = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
const R = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\nEIGHT\n';
const props = (over: Partial<DiffViewProps> = {}): DiffViewProps => ({
  title: 'Compare text',
  path: 'right.md',
  base: L,
  current: R,
  baseLabel: 'left.md',
  currentLabel: 'right.md',
  layout: 'split',
  onLayout: vi.fn(),
  onClose: vi.fn(),
  engine: 'built-in diff',
  ...over,
});
const both = (over: Partial<DiffViewProps> = {}) => props({ editable: true, basePath: 'left.md', apply: { nameA: 'left.md', nameB: 'right.md', toA: true, toB: true }, ...over });
const viewOf = (el: Element, i = 0) => EditorView.findFromDOM(el.querySelectorAll<HTMLElement>('.cm-editor')[i])!;
const buttons = (el: Element, to: 'a' | 'b') => [...el.querySelectorAll<HTMLButtonElement>(`.se-git-revert[data-to="${to}"]`)];
/** Mounts the view over two open documents. */
async function mount(p: DiffViewProps) {
  openDoc('left.md', L);
  openDoc('right.md', R);
  const { ed, docs } = fakeEditor({ 'left.md': L, 'right.md': R });
  app.editor = ed;
  const old = document.getElementById('h');
  if (old) act(() => render(null, old)); // a view left mounted would still answer keys
  const el = host();
  await act(async () => {
    render(<DiffView {...p} />, el);
    await tick(30); // the merge view places its controls in a frame
  });
  return { el, docs };
}
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...mods })));

// The arrows between the editors (side by side) are placed by the merge view from measured layout, which
// happy-dom has none of: they are covered in tests/e2e/git-compare-apply.spec.ts. Here: the same code
// through the keyboard, and the unified layout's buttons.
describe('DiffView, compare: apply a block to the other side', () => {
  it('side by side, two workspace files: both editors take text; a block lands in the right document, either way', async () => {
    const { el, docs } = await mount(both());
    expect(el.querySelector('.se-git-diff')!.getAttribute('data-apply')).toBe('ab');
    expect(el.querySelector('.cm-merge-revert')).not.toBeNull(); // the column for the arrows
    expect(el.querySelector('[data-testid="git-diff-editable"]')!.textContent).toContain('both sides editable');
    const [a, b] = [viewOf(el, 0), viewOf(el, 1)];
    expect([a.state.readOnly, b.state.readOnly]).toEqual([false, false]);
    b.contentDOM.blur();

    act(() => b.dispatch({ selection: { anchor: R.indexOf('TWO') } }));
    await key('F7', { shiftKey: true }); // right → left: TWO goes left
    expect(docs['left.md']).toBe(L.replace('two', 'TWO'));
    expect(docs['right.md']).toBe(R);
    expect(a.state.doc.toString()).toBe(docs['left.md']);
    expect(a.hasFocus).toBe(true); // Ctrl+Z belongs to the side that just changed
    a.contentDOM.blur();
    act(() => b.dispatch({ selection: { anchor: R.indexOf('EIGHT') } }));
    await key('F7'); // left → right: eight goes right
    expect(docs['right.md']).toBe(R.replace('EIGHT', 'eight'));
    expect(docs['left.md']).toBe(docs['right.md']);
    expect(app.docs.get('left.md')!.dirty.value).toBe(true);
    expect(app.docs.get('right.md')!.dirty.value).toBe(true);
    await act(async () => void (await tick(200)));
    expect(el.querySelector('[data-testid="git-diff-stats"]')!.textContent).toBe('+0 −0');
    expect(viewOf(el, 0)).toBe(a); // the same editors: nothing was rebuilt
    expect(viewOf(el, 1)).toBe(b);
  });

  it('typing on the left (side by side) goes to the left file', async () => {
    const { el, docs } = await mount(both());
    const a = viewOf(el, 0);
    await act(async () => void a.dispatch({ changes: { from: 0, insert: 'zero\n' }, userEvent: 'input.type' }));
    expect(docs['left.md']).toBe('zero\n' + L);
    expect(docs['right.md']).toBe(R);
  });

  it('a read-only side gets no control pointing at it, and stays read-only', async () => {
    const clip = { basePath: 'left.md', currentLabel: 'Clipboard', apply: { nameA: 'left.md', nameB: 'Clipboard', toA: true, toB: false } };
    const sel = { editable: true, baseLabel: 'Selection', apply: { nameA: 'Selection', nameB: 'right.md', toA: false, toB: true } };
    const none = { baseLabel: 'Selection', currentLabel: 'Clipboard', apply: { nameA: 'Selection', nameB: 'Clipboard', toA: false, toB: false } };

    let m = await mount(props({ ...clip, layout: 'unified' }));
    expect(buttons(m.el, 'b')).toHaveLength(0);
    expect(buttons(m.el, 'a')).toHaveLength(2);
    m = await mount(props(clip));
    expect(m.el.querySelector('.se-git-diff')!.getAttribute('data-apply')).toBe('a');
    expect([viewOf(m.el, 0).state.readOnly, viewOf(m.el, 1).state.readOnly]).toEqual([false, true]);
    await key('F7'); // Ctrl+F7 = "to the right": nothing may happen to a read-only side
    expect(viewOf(m.el, 1).state.doc.toString()).toBe(R);
    expect(m.docs['left.md']).toBe(L);

    m = await mount(props({ ...sel, layout: 'unified' }));
    expect(buttons(m.el, 'a')).toHaveLength(0);
    expect(buttons(m.el, 'b')).toHaveLength(2);
    m = await mount(props(sel));
    expect(m.el.querySelector('.se-git-diff')!.getAttribute('data-apply')).toBe('b');
    expect([viewOf(m.el, 0).state.readOnly, viewOf(m.el, 1).state.readOnly]).toEqual([true, false]);
    await key('F7', { shiftKey: true }); // no left target: Ctrl+Shift+F7 never writes to the left
    expect(viewOf(m.el, 0).state.doc.toString()).toBe(L);

    for (const layout of ['unified', 'split'] as const) {
      m = await mount(props({ ...none, layout }));
      expect(m.el.querySelector('.se-git-revert')).toBeNull();
      expect(m.el.querySelector('.cm-merge-revert')).toBeNull();
      expect(m.el.querySelector('.se-git-diff')!.getAttribute('data-apply')).toBeNull();
      await key('F7');
      await key('F7', { shiftKey: true });
      expect(viewOf(m.el, layout === 'split' ? 1 : 0).state.doc.toString()).toBe(R); // not even in the view
    }
  });

  it('a git diff keeps its one "Revert" (no apply wording, nothing towards the commit)', async () => {
    const { el } = await mount(props({ editable: true, title: undefined, engine: undefined, layout: 'unified' }));
    expect(buttons(el, 'a')).toHaveLength(0);
    expect(buttons(el, 'b').map((b) => b.textContent)).toEqual(['Revert', 'Revert']);
    expect(buttons(el, 'b')[0].getAttribute('aria-label')).toBe('Revert this block: put the old lines back');
    expect(el.querySelector('.se-git-diff')!.getAttribute('data-apply')).toBe('b');
  });

  it('unified: "Apply to ‹name›" each way; the left file changes without an editor of its own, Ctrl+Z / Ctrl+Y walk both', async () => {
    const { el, docs } = await mount(both({ layout: 'unified' }));
    expect(buttons(el, 'a').map((b) => b.textContent)).toEqual(['Apply to left.md', 'Apply to left.md']);
    expect(buttons(el, 'b').map((b) => b.textContent)).toEqual(['Apply to right.md', 'Apply to right.md']);
    expect(buttons(el, 'a')[0].getAttribute('aria-label')).toBe('Apply this block to left.md (the left side)');
    expect(buttons(el, 'b')[0].getAttribute('aria-label')).toBe('Apply this block to right.md (the right side)');
    const v = viewOf(el);

    await act(async () => void buttons(el, 'a')[0].click());
    expect(docs['left.md']).toBe(L.replace('two', 'TWO'));
    expect(getOriginalDoc(v.state).toString()).toBe(docs['left.md']);
    expect(docs['right.md']).toBe(R);
    await act(async () => void buttons(el, 'b')[0].click()); // one block left: eight comes back on the right
    expect(docs['right.md']).toBe(R.replace('EIGHT', 'eight'));

    v.contentDOM.blur();
    await key('z'); // the newest step first: the right side
    expect(docs['right.md']).toBe(R);
    expect(docs['left.md']).toBe(L.replace('two', 'TWO'));
    await key('z'); // then the left side
    expect(docs['left.md']).toBe(L);
    expect(app.docs.get('left.md')!.dirty.value).toBe(false);
    await key('y');
    expect(docs['left.md']).toBe(L.replace('two', 'TWO'));
    expect(docs['right.md']).toBe(R);
    await key('y');
    expect(docs['right.md']).toBe(R.replace('EIGHT', 'eight'));
  });

  it('unified with a read-only right side (the clipboard): only "Apply to ‹left›", undoable', async () => {
    const { el, docs } = await mount(props({ layout: 'unified', basePath: 'left.md', currentLabel: 'Clipboard', apply: { nameA: 'left.md', nameB: 'Clipboard', toA: true, toB: false } }));
    expect(buttons(el, 'b')).toHaveLength(0);
    expect(viewOf(el).state.readOnly).toBe(true);
    await act(async () => void buttons(el, 'a')[1].click());
    expect(docs['left.md']).toBe(L.replace('eight', 'EIGHT'));
    await key('z');
    expect(docs['left.md']).toBe(L);
    expect(viewOf(el).state.doc.toString()).toBe(R);
  });

  it('a change of the left file elsewhere shows up on the left and is not sent back', async () => {
    for (const layout of ['split', 'unified'] as const) {
      const { el, docs } = await mount(both({ layout }));
      await act(async () => void app.editor!.setContent('left.md', 'zero\n' + L));
      const left = layout === 'split' ? viewOf(el, 0).state.doc : getOriginalDoc(viewOf(el).state);
      expect(left.toString()).toBe('zero\n' + L);
      expect(docs['left.md']).toBe('zero\n' + L);
      expect(docs['right.md']).toBe(R);
    }
  });

  it('ignore whitespace: the controls are there, switched off, and say why; nothing is applied or typed', async () => {
    for (const layout of ['split', 'unified'] as const) {
      const { el, docs } = await mount(props({ layout, apply: { nameA: 'left.md', nameB: 'right.md', toA: true, toB: true, off: WHITESPACE_OFF } }));
      expect(el.querySelector('.se-git-diff')!.getAttribute('data-apply')).toBe('ab');
      if (layout === 'unified') {
        const all = [...buttons(el, 'a'), ...buttons(el, 'b')];
        expect(all).toHaveLength(4);
        for (const b of all) {
          expect(b.getAttribute('aria-disabled')).toBe('true');
          expect(b.title).toBe(WHITESPACE_OFF);
        }
        await act(async () => void all.forEach((b) => b.click()));
      }
      await key('F7');
      await key('F7', { shiftKey: true });
      expect(docs['left.md']).toBe(L);
      expect(docs['right.md']).toBe(R);
      expect(viewOf(el, 0).state.readOnly).toBe(true);
      expect(viewOf(el, layout === 'split' ? 1 : 0).state.doc.toString()).toBe(R);
      expect(el.querySelector('[data-testid="git-diff-editable"]')).toBeNull();
    }
  });
});
