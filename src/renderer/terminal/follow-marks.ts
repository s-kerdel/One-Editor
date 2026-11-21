// "Follow Claude's edits": the editor state behind the green flash and the "changed this turn" marks.
// CodeMirror state only (no app, no DOM), so the rules are unit-tested on a plain EditorState.
// Both sets are line decorations: they move with the text (`map(tr.changes)`) and go when their line does.
import { StateEffect, StateField, type EditorState, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** 1-based line ranges, inclusive. */
export type Lines = Array<[number, number]>;

/** Lines one edit may flash. */
export const MAX_FLASH_LINES = 400;
/** Marked lines per document and turn; more are not marked. */
export const MAX_MARKS_PER_FILE = 2000;

export interface FollowAdd {
  lines: Lines;
  /** Claude's turn the marks belong to: marks of another turn go at the next sync. */
  turn: number;
  /** Also flash, until this time (ms). 0: marks only. */
  until: number;
}

/** Lines Claude changed: mark them, and flash them when `until` is set. Flashes already running stay. */
export const followAdd = StateEffect.define<FollowAdd>();
/** Housekeeping: drop flashes that ran out at `now` and marks that are not of turn `turn`. */
export const followSync = StateEffect.define<{ now: number; turn: number }>();

interface FollowValue {
  flash: DecorationSet;
  marks: DecorationSet;
}

/** Line-start positions of `lines` in `doc`: sorted, each line once, at most `max`. */
export function lineStarts(doc: Text, lines: Lines, max: number): number[] {
  const out = new Set<number>();
  for (const [a, b] of lines) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    for (let n = Math.max(a, 1); n <= Math.min(b, doc.lines) && out.size < max; n++) out.add(doc.line(n).from);
  }
  return [...out].sort((x, y) => x - y);
}

const flashDeco = (until: number) => Decoration.line({ class: 'se-claude-flash', until });
const markDeco = (turn: number) => Decoration.line({ class: 'se-claude-turn', turn });

/** `set` without the decorations that fail `ok`; the same object when all pass (no redraw for nothing). */
function keep(set: DecorationSet, ok: (d: Decoration) => boolean): DecorationSet {
  if (!set.size) return set;
  const next = set.update({ filter: (_f, _t, d) => ok(d) });
  return next.size === set.size ? set : next;
}

export const followField = StateField.define<FollowValue>({
  create: () => ({ flash: Decoration.none, marks: Decoration.none }),
  update(v, tr) {
    let { flash, marks } = v;
    if (tr.docChanged) {
      flash = flash.map(tr.changes);
      marks = marks.map(tr.changes);
    }
    for (const fx of tr.effects) {
      if (fx.is(followSync)) {
        const { now, turn } = fx.value;
        flash = keep(flash, (d) => d.spec.until > now);
        marks = keep(marks, (d) => d.spec.turn === turn);
      } else if (fx.is(followAdd)) {
        const { lines, turn, until } = fx.value;
        const doc = tr.state.doc;
        if (until > 0) {
          // A line flashing again starts over; the other flashes keep their own end time.
          const starts = lineStarts(doc, lines, MAX_FLASH_LINES);
          const again = new Set(starts);
          const deco = flashDeco(until);
          flash = flash.update({ filter: (from) => !again.has(from), add: starts.map((p) => deco.range(p)) });
        }
        const have = new Set<number>();
        for (let c = marks.iter(); c.value; c.next()) have.add(c.from);
        const room = MAX_MARKS_PER_FILE - have.size;
        if (room > 0) {
          const deco = markDeco(turn);
          const add: Range<Decoration>[] = [];
          for (const p of lineStarts(doc, lines, MAX_MARKS_PER_FILE)) {
            if (add.length >= room) break;
            if (!have.has(p)) add.push(deco.range(p));
          }
          if (add.length) marks = marks.update({ add });
        }
      }
    }
    return flash === v.flash && marks === v.marks ? v : { flash, marks };
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.flash), EditorView.decorations.from(f, (v) => v.marks)],
});

/** The 1-based lines that flash / are marked now (tests, and "is there anything to clear"). */
export function followLines(state: EditorState): { flash: number[]; marks: number[] } {
  const v = state.field(followField, false);
  const of = (set: DecorationSet | undefined) => {
    const out: number[] = [];
    if (set) for (let c = set.iter(); c.value; c.next()) out.push(state.doc.lineAt(c.from).number);
    return out;
  };
  return { flash: of(v?.flash), marks: of(v?.marks) };
}
