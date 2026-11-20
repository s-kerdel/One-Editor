// Editing in the diff view (lazy diff chunk). Only the working-copy side is ever editable, and it is not
// a second buffer: every edit is forwarded to the file's open document (the one its editor tab shows), so
// the unsaved dot, Ctrl+S, autosave, line endings and disk-change handling are the editor's own.
// Pure parts (which side is editable, reverting a block, save → stage order) are unit-tested.
import type { Text } from '@codemirror/state';
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

/** Only ever the right side, and only when it IS the workspace file. */
export function editableSide(s: DiffSource): 'b' | null {
  if (s.kind === 'working') return s.text ? 'b' : null;
  if (s.kind === 'compare') return s.path && s.whole && s.live && !s.ignoreWhitespace ? 'b' : null;
  return null;
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

/** The block under a working-copy position (a pure deletion: the spot its lines were at). */
export function blockAt<T extends Block>(blocks: readonly T[], pos: number): T | null {
  return blocks.find((c) => c.fromB <= pos && Math.max(c.fromB, c.toB - 1) >= pos) ?? null;
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
