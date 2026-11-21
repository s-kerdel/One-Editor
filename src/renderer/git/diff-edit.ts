// Editing in the diff view (lazy diff chunk). Only the working-copy side is ever editable, and it is not
// a second buffer: every edit is forwarded to the file's open document (the one its editor tab shows), so
// the unsaved dot, Ctrl+S, autosave, line endings and disk-change handling are the editor's own.
// Compare (two files / sources) follows the same model on both sides: a side takes text only when it IS a
// workspace file, and a block can be applied from either side to such a side.
// Pure parts (which side is editable, applying / reverting a block, save → stage order) are unit-tested.
import type { ChangeSet, Text } from '@codemirror/state';
import type { GitHunk } from '@shared/git';
import { app } from '../app/app';

/** Where the right-hand text of a diff comes from. */
export type DiffSource =
  /** HEAD / index → the file in the folder. `text`: false when it is gone or not text. */
  | { kind: 'working'; text: boolean }
  /** History: both sides are commits. */
  | { kind: 'commit' }
  /** Compare text. `whole`: the right side is a whole file (not a selection, not the clipboard);
   *  `live`: it is open and shown exactly as it is now. */
  | { kind: 'compare'; path?: string; whole: boolean; live: boolean; ignoreWhitespace: boolean };

/** Git diffs: only ever the right side, and only when it IS the workspace file. (Compare: `compareTargets`.) */
export function editableSide(s: DiffSource): 'b' | null {
  if (s.kind === 'working') return s.text ? 'b' : null;
  if (s.kind === 'compare') {
    const t = compareTargets({ whole: false, live: false }, s, s.ignoreWhitespace);
    return t.b && !t.off ? 'b' : null;
  }
  return null;
}

/** One side of a compare. `whole`: a whole file (not a selection, not the clipboard); `live`: shown
 *  exactly as the file is now (its open document, or the file on disk when no tab holds it). */
export interface CompareSide {
  path?: string;
  whole: boolean;
  live: boolean;
}

export const WHITESPACE_OFF = 'Switch off “Ignore whitespace” to apply blocks: the blocks shown leave out lines that differ only in spaces.';

/**
 * Which sides of a compare can take a block from the other side (and be typed in): only a side that IS
 * a workspace file. HEAD, a commit, the clipboard, a selection or a remembered text are sources only.
 * `off`: why nothing can be applied (or typed) right now, although those sides could take it.
 */
export function compareTargets(a: CompareSide, b: CompareSide, ignoreWhitespace: boolean): { a: boolean; b: boolean; off?: string } {
  const file = (s: CompareSide) => !!s.path && s.whole && s.live;
  // The same file on both sides is one document: the right side is it, the left a copy to read.
  const can = { a: file(a) && !(file(b) && a.path === b.path), b: file(b) };
  return ignoreWhitespace && (can.a || can.b) ? { ...can, off: WHITESPACE_OFF } : can;
}

/** A changed block as the merge view keeps it (`to` may point one past the end of the text). */
export interface Block {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** The edit that puts the old side's lines of `c` back into the working copy `b`. */
export function revertChange(c: Block, a: Text, b: Text): { from: number; to: number; insert: string } {
  let insert = a.sliceString(c.fromA, Math.max(c.fromA, c.toA - 1));
  if (c.fromA !== c.toA && c.toB <= b.length) insert += '\n';
  return { from: c.fromB, to: Math.min(b.length, c.toB), insert };
}

/** The edit that makes side `to` of block `c` the same as the other side (`to` = 'b': revertChange). */
export function applyChange(c: Block, to: 'a' | 'b', a: Text, b: Text): Edit {
  return to === 'b' ? revertChange(c, a, b) : revertChange({ fromA: c.fromB, toA: c.toB, fromB: c.fromA, toB: c.toA }, b, a);
}

/** The block under a position of side `side` (a pure deletion / insertion: the spot its lines were at). */
export function blockAt<T extends Block>(blocks: readonly T[], pos: number, side: 'a' | 'b' = 'b'): T | null {
  return blocks.find((c) => (side === 'b' ? c.fromB <= pos && Math.max(c.fromB, c.toB - 1) >= pos : c.fromA <= pos && Math.max(c.fromA, c.toA - 1) >= pos)) ?? null;
}

/**
 * Undo / redo for blocks applied to the LEFT side of a unified compare: there the left text lives in
 * the view's state, not in an editor with a history of its own. Each step remembers how deep the
 * right side's history was, so Ctrl+Z walks both sides back in the order things happened.
 */
export class SideHistory {
  private done: Array<{ change: ChangeSet; depth: number }> = [];
  private undone: Array<{ change: ChangeSet; depth: number }> = [];

  /** A change was made to the side; `inverse` takes it back. `by`: it was this history's own step. */
  record(by: 'undo' | 'redo' | undefined, inverse: ChangeSet, depth: { undo: number; redo: number }) {
    if (by === 'undo') return void this.undone.push({ change: inverse, depth: depth.redo });
    if (!by) this.undone = [];
    this.done.push({ change: inverse, depth: depth.undo });
  }

  /** The next step for this side; null while the other side (`depth` steps on its stack) goes first. */
  take(kind: 'undo' | 'redo', depth: number): ChangeSet | null {
    const stack = kind === 'undo' ? this.done : this.undone;
    const top = stack[stack.length - 1];
    if (!top || depth > top.depth) return null;
    stack.pop();
    return top.change;
  }

  /** The other side was edited: what was undone here cannot come back in order any more. */
  clearRedo() {
    this.undone = [];
  }

  /** The side's text changed from outside (its tab, the disk): the steps no longer fit it. */
  clear() {
    this.done = [];
    this.undone = [];
  }
}

/** Working-copy line range [b0, b1) of a block (0-based), to match it with git's blocks. */
export function blockLines(c: Block, b: Text): [number, number] {
  const b0 = b.lineAt(Math.min(c.fromB, b.length)).number - 1;
  return [b0, c.toB > c.fromB ? b.lineAt(Math.min(b.length, c.toB - 1)).number : b0];
}

/** The git block a working-copy line (0-based) belongs to; -1: none (the edit removed it). */
export function hunkAtLine(hunks: readonly GitHunk[], line: number): number {
  return hunks.findIndex((h) => (h.b1 > h.b0 ? line >= h.b0 && line < h.b1 : line === h.b0));
}

/**
 * "Include in commit" on a block while the file has unsaved edits: git only knows the file on disk, so
 * save first, then read the blocks again and pick the one at the clicked spot. Null: nothing to stage
 * (the save failed and said why, or the block is gone).
 */
export async function saveThenPick(o: { save(): Promise<boolean>; line(): number; hunks(): Promise<readonly GitHunk[] | null> }): Promise<number | null> {
  if (!(await o.save())) return null;
  let line: number;
  try {
    line = o.line(); // after the save (format on save may move lines), before the bars are redrawn
  } catch {
    return null;
  }
  const list = await o.hunks();
  const k = list ? hunkAtLine(list, line) : -1;
  return k < 0 ? null : k;
}

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** The open document of `path`, as the diff view needs it. */
export interface WorkingCopy {
  /** Its text now; undefined: no tab holds it yet. */
  text(): string | undefined;
  dirty(): boolean;
  /** An edit made in the diff view (`edits` against the text before it, `text` = the result). */
  push(edits: Edit[], text: () => string): void;
  /** The document changed or was saved. `external`: not by push() (its tab, a reload from disk, format on save). */
  onChange(cb: (external: boolean) => void): () => void;
  save(): Promise<boolean>;
}

export function workingCopy(path: string): WorkingCopy {
  let opening: Promise<void> | null = null;
  let pushing = false;
  const text = () => (app.docs.has(path) ? (app.editor?.getContent(path) ?? app.docs.get(path)!.content) : undefined);
  const inEditor = () => app.docs.has(path) && app.editor?.getContent(path) !== undefined;
  const guarded = (fn: () => void) => {
    pushing = true;
    try {
      fn();
    } finally {
      pushing = false;
    }
  };
  return {
    text,
    dirty: () => !!app.docs.get(path)?.dirty.peek(),
    push(edits, now) {
      if (opening) return; // the whole text goes in once the tab is there
      const ed = app.editor;
      if (ed && inEditor()) return guarded(() => (ed.applyChanges ? ed.applyChanges(path, edits) : ed.setContent(path, now())));
      // No tab yet: the first edit gives the file one, so the edit lives in a real (dirty) document.
      opening = app
        .openFile(path)
        .then(() => {
          opening = null;
          if (!inEditor()) throw new Error('not open');
          const want = now();
          if (app.editor!.getContent(path) !== want) guarded(() => app.editor!.setContent(path, want));
        })
        .catch(() => {
          opening = null;
          app.toast(`Could not open ${path} for editing: the edit is only in the diff view`, 'error', 8000);
        });
    },
    onChange(cb) {
      const on = (p: string) => {
        if (p === path) cb(!pushing && !opening);
      };
      const offs = [app.events.on('doc:changed', on), app.events.on('doc:saved', on)];
      return () => offs.forEach((off) => off());
    },
    async save() {
      if (opening) await opening;
      return app.docs.has(path) ? app.saveFile(path) : true;
    },
  };
}
