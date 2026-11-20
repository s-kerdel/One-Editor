// @vitest-environment happy-dom
// Editing in the diff view: which side is editable per diff source, reverting one block of several,
// save → stage order for a block ticked on unsaved edits, and the view's edits reaching the open document.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { signal } from '@preact/signals';
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Chunk } from '@codemirror/merge';
import type { GitHunk } from '@shared/git';
import { app, type DocState, type EditorController } from '../../../src/renderer/app/app';
import { blockAt, blockLines, editableSide, hunkAtLine, revertChange, saveThenPick, workingCopy } from '../../../src/renderer/git/diff-edit';
import { DiffView, type DiffViewProps } from '../../../src/renderer/git/DiffView';
import { GitStore } from '../../../src/renderer/git/store';
import { openChange, openCommitDiff, openDiffWithHead } from '../../../src/renderer/git/diff-open';

const text = (s: string) => Text.of(s.split('\n'));
const hunk = (b0: number, b1: number, a0 = b0, a1 = b1): GitHunk => ({ a0, a1, b0, b1, state: 'unstaged' }) as GitHunk;

describe('editableSide: only the working copy', () => {
  it('HEAD / index → the file in the folder: editable while it is a text file that exists', () => {
    expect(editableSide({ kind: 'working', text: true })).toBe('b');
    expect(editableSide({ kind: 'working', text: false })).toBeNull(); // deleted on disk, binary
  });

  it('History (commit vs its parent): read-only', () => {
    expect(editableSide({ kind: 'commit' })).toBeNull();
  });

  it('compare text: only a whole open file on the right, shown as it is now, whitespace not ignored', () => {
    const file = { kind: 'compare', path: 'a.md', whole: true, live: true, ignoreWhitespace: false } as const;
    expect(editableSide(file)).toBe('b');
    expect(editableSide({ ...file, path: undefined })).toBeNull(); // the clipboard
    expect(editableSide({ ...file, whole: false })).toBeNull(); // a selection
    expect(editableSide({ ...file, live: false })).toBeNull(); // a remembered text / not open
    expect(editableSide({ ...file, ignoreWhitespace: true })).toBeNull();
  });
});

describe('revertChange', () => {
  const A = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
  const B = 'one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\nextra\neight\nnine\n';

  it('one block of several: only its lines go back', () => {
    const a = text(A);
    const b = text(B);
    const chunks = Chunk.build(a, b);
    expect(chunks.length).toBe(3);
    const c = chunks[1];
    const ch = revertChange(c, a, b);
    const out = B.slice(0, ch.from) + ch.insert + B.slice(ch.to);
    expect(out).toBe('one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\n');
  });

  it('an added block at the end and a removed block', () => {
    const a = text(A);
    const b = text(B);
    const last = Chunk.build(a, b)[2];
    const ch = revertChange(last, a, b);
    expect(B.slice(0, ch.from) + ch.insert + B.slice(ch.to)).toBe('one\nTWO\nthree\nfour\nfive\nsix\nSEVEN\nextra\neight\n');

    const gone = 'one\nthree\n';
    const src = 'one\ntwo\nthree\n';
    const [c] = Chunk.build(text(src), text(gone));
    const back = revertChange(c, text(src), text(gone));
    expect(gone.slice(0, back.from) + back.insert + gone.slice(back.to)).toBe(src);
  });

  it('reverting every block gives the old text', () => {
    let cur = B;
    for (let i = 0; i < 5 && cur !== A; i++) {
      const c = Chunk.build(text(A), text(cur))[0];
      const ch = revertChange(c, text(A), text(cur));
      cur = cur.slice(0, ch.from) + ch.insert + cur.slice(ch.to);
    }
    expect(cur).toBe(A);
  });

  it('blockAt / blockLines: the block under a position, as working-copy lines', () => {
    const b = text(B);
    const chunks = Chunk.build(text(A), b);
    expect(blockAt(chunks, B.indexOf('TWO') + 1)).toBe(chunks[0]);
    expect(blockAt(chunks, B.indexOf('four'))).toBeNull();
    expect(blockLines(chunks[0], b)).toEqual([1, 2]);
    expect(blockLines(chunks[1], b)).toEqual([6, 8]);
  });
});

describe('saveThenPick: a block ticked on unsaved edits', () => {
  it('saves first, then reads the blocks, then picks the one at the clicked line', async () => {
    const order: string[] = [];
    const k = await saveThenPick({
      save: async () => (order.push('save'), true),
      line: () => (order.push('line'), 7),
      hunks: async () => (order.push('hunks'), [hunk(1, 2), hunk(6, 9), hunk(20, 21)]),
    });
    expect(order).toEqual(['save', 'line', 'hunks']);
    expect(k).toBe(1);
  });

  it('a failed save stages nothing (and asks git nothing)', async () => {
    const hunks = vi.fn(async () => [hunk(0, 1)]);
    expect(await saveThenPick({ save: async () => false, line: () => 0, hunks })).toBeNull();
    expect(hunks).not.toHaveBeenCalled();
  });

  it('the block is gone after the save, or the bar no longer exists: nothing', async () => {
    expect(await saveThenPick({ save: async () => true, line: () => 4, hunks: async () => [hunk(0, 1)] })).toBeNull();
    expect(await saveThenPick({ save: async () => true, line: () => 0, hunks: async () => null })).toBeNull();
    const gone = () => {
      throw new Error('no DOM');
    };
    expect(await saveThenPick({ save: async () => true, line: gone, hunks: async () => [hunk(0, 1)] })).toBeNull();
  });

  it('hunkAtLine: changed lines, and a pure deletion by its spot', () => {
    const list = [hunk(2, 4), hunk(9, 9, 9, 11)];
    expect(hunkAtLine(list, 3)).toBe(0);
    expect(hunkAtLine(list, 4)).toBe(-1);
    expect(hunkAtLine(list, 9)).toBe(1);
  });
});

// ---- the view against a stand-in editor ------------------------------------------------------------
const host = () => {
  document.body.innerHTML = '<div id="h"></div>';
  return document.getElementById('h')!;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** The parts of the editor the binding uses, over a plain string per path. */
function fakeEditor(docs: Record<string, string>) {
  const applied: Array<{ path: string; changes: Array<{ from: number; to: number; insert: string }> }> = [];
  const ed = {
    getContent: (p?: string) => (p ? docs[p] : undefined),
    setContent(p: string, t: string) {
      docs[p] = t;
      app.docs.get(p)!.content = t;
      app.docs.get(p)!.dirty.value = t !== app.docs.get(p)!.saved;
      app.events.emit('doc:changed', p, t);
    },
    applyChanges(p: string, changes: Array<{ from: number; to: number; insert: string }>) {
      applied.push({ path: p, changes });
      let t = docs[p];
      for (const c of [...changes].sort((x, y) => y.from - x.from)) t = t.slice(0, c.from) + c.insert + t.slice(c.to);
      ed.setContent(p, t);
    },
    focus() {},
  };
  return { ed: ed as unknown as EditorController, applied, docs };
}

const props = (over: Partial<DiffViewProps> = {}): DiffViewProps => ({
  path: 'notes/a.md',
  base: 'one\ntwo\nthree\n',
  current: 'one\nTWO\nthree\nfour\n',
  baseLabel: 'Last commit (ccccccc)',
  currentLabel: 'Working copy',
  layout: 'unified',
  onLayout: vi.fn(),
  onClose: vi.fn(),
  ...over,
});
const openDoc = (path: string, content: string, saved = content) => app.docs.set(path, { path, saved, content, mtime: 0, eol: 'lf', dirty: signal(content !== saved) } as DocState);
const viewOf = (el: Element, i = 0) => EditorView.findFromDOM(el.querySelectorAll<HTMLElement>('.cm-editor')[i])!;

afterEach(() => {
  render(null, document.getElementById('h') ?? document.body);
  app.overlay.value = null;
  app.docs.clear();
  app.editor = null;
});

describe('DiffView, editable', () => {
  it('read-only by default (History, HEAD side): no revert controls, aria-readonly', () => {
    const el = host();
    act(() => render(<DiffView {...props({ layout: 'split' })} />, el));
    expect(el.querySelector('.se-git-diff')!.getAttribute('data-editable')).toBeNull();
    expect(el.querySelectorAll('.cm-content[aria-readonly="true"]')).toHaveLength(2);
    expect(el.querySelector('.se-git-revert')).toBeNull();
    expect(viewOf(el, 1).state.readOnly).toBe(true);
  });

  it('typing goes to the open document (dirty), the header says so; the old side stays read-only', async () => {
    const p = props({ editable: true, layout: 'split' });
    openDoc(p.path, p.current);
    const { ed, applied, docs } = fakeEditor({ [p.path]: p.current });
    app.editor = ed;
    const el = host();
    act(() => render(<DiffView {...p} />, el));
    expect(el.querySelector('[data-testid="git-diff-editable"]')!.textContent).toContain('editable');
    expect(viewOf(el, 0).state.readOnly).toBe(true);
    const b = viewOf(el, 1);
    expect(b.state.readOnly).toBe(false);
    expect(b.contentDOM.getAttribute('aria-readonly')).toBeNull();
    await act(async () => {
      b.dispatch({ changes: { from: b.state.doc.length, insert: 'five\n' }, userEvent: 'input.type' });
      await tick(200);
    });
    expect(applied).toHaveLength(1);
    expect(docs[p.path]).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(app.docs.get(p.path)!.dirty.value).toBe(true);
    expect(el.querySelector('.se-git-diff-sub')!.textContent).toContain('unsaved edits');
    expect(el.querySelector('[data-testid="git-diff-stats"]')!.textContent).toBe('+3 −1');
  });

  it('a change of the document elsewhere shows up in the view and is not sent back', async () => {
    const p = props({ editable: true });
    openDoc(p.path, p.current);
    const { ed, applied } = fakeEditor({ [p.path]: p.current });
    app.editor = ed;
    const el = host();
    act(() => render(<DiffView {...p} />, el));
    await act(async () => {
      ed.setContent(p.path, 'one\nTWO\nthree\nFOUR\n');
      await tick(200);
    });
    expect(viewOf(el).state.doc.toString()).toBe('one\nTWO\nthree\nFOUR\n');
    expect(applied).toHaveLength(0);
  });

  it('revert control per block (unified): the old lines come back as an edit of the document', async () => {
    const p = props({ editable: true, base: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', current: 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n' });
    openDoc(p.path, p.current);
    const { ed, docs } = fakeEditor({ [p.path]: p.current });
    app.editor = ed;
    const el = host();
    act(() => render(<DiffView {...p} />, el));
    const buttons = el.querySelectorAll<HTMLButtonElement>('.cm-chunkButtons .se-git-revert');
    expect(buttons).toHaveLength(2); // revert only: nothing to "accept"
    expect(buttons[0].getAttribute('aria-label')).toContain('Revert this block');
    await act(async () => {
      buttons[1].click();
      await tick(200);
    });
    expect(docs[p.path]).toBe('a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n');
    expect(el.querySelector('[data-testid="git-diff-stats"]')!.textContent).toBe('+1 −1');
  });

  it('no tab yet: the first edit opens the file and puts the edited text into its document', async () => {
    const p = props({ editable: true });
    const { ed, docs } = fakeEditor({});
    app.editor = ed;
    const openFile = vi.fn(async (path: string) => {
      openDoc(path, p.current);
      docs[path] = p.current;
    });
    app.openFile = openFile;
    const el = host();
    act(() => render(<DiffView {...p} />, el));
    const v = viewOf(el);
    await act(async () => {
      // (Appended: happy-dom reports a moved caret synchronously, inside CodeMirror's own update.)
      v.dispatch({ changes: { from: v.state.doc.length, insert: 'five\n' } });
      v.dispatch({ changes: { from: v.state.doc.length, insert: 'six\n' } });
      await tick(200);
    });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(docs[p.path]).toBe('one\nTWO\nthree\nfour\nfive\nsix\n');
    expect(app.docs.get(p.path)!.dirty.value).toBe(true);
  });
});

describe('workingCopy.save', () => {
  it('saves the file of the diff (not the active tab)', async () => {
    openDoc('notes/a.md', 'x');
    const save = vi.fn(async (_path?: string) => true);
    app.saveFile = save;
    await workingCopy('notes/a.md').save();
    expect(save).toHaveBeenCalledWith('notes/a.md');
  });
});

describe('openers decide who may edit', () => {
  const OID = 'c'.repeat(40);
  async function store() {
    const s = new GitStore({
      gitStatus: async () => ({ ok: true, branch: { head: 'main', oid: OID, detached: false, upstream: null, ahead: 0, behind: 0 }, entries: [{ path: 'notes/a.md', state: 'modified', unstaged: true }], prefix: '', ms: 1 }),
      gitHeadFile: async (_p, rev) => ({ content: 'old\n', oid: rev ?? OID }),
    });
    await s.refreshNow();
    return s;
  }
  const shown = (): Record<string, unknown> => {
    // The overlay component closes over the props: render it shallowly through its own vnode.
    const Overlay = app.overlay.value as unknown as () => { props: Record<string, unknown> };
    return Overlay().props;
  };

  it('Diff with last commit on an open file: editable', async () => {
    openDoc('notes/a.md', 'new\n');
    expect(await openDiffWithHead(await store(), 'notes/a.md')).toBe(true);
    expect(shown().editable).toBe(true);
    expect(shown().currentLabel).toBe('Working copy');
  });

  it('a file that is gone from the folder: read-only (everything shows as removed)', async () => {
    (app as unknown as { backend: unknown }).backend = { readFile: async () => Promise.reject(new Error('ENOENT')) };
    expect(await openDiffWithHead(await store(), 'notes/a.md')).toBe(true);
    expect(shown().editable).toBe(false);
    expect(shown().current).toBe('');
  });

  it('a new file from the pane: editable; a commit from History: read-only', async () => {
    openDoc('new.md', '# new\n');
    await openChange(await store(), 'new.md');
    expect(shown().editable).toBe(true);
    (app as unknown as { backend: unknown }).backend = { git: async () => ({ content: 'x\n' }) };
    await openCommitDiff({ path: 'notes/a.md', status: 'modified' }, { oid: OID, parent: 'd'.repeat(40) });
    expect(shown().editable).toBe(false);
  });
});
