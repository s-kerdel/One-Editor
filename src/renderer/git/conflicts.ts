// Merge-conflict blocks in the editor: <<<<<<< / ||||||| / ======= / >>>>>>> lines and the two sides
// are tinted, and the <<<<<<< line offers "Accept current | Accept incoming | Accept both" (one undo
// step each). Files without markers pay one line scan when opened, then only the edited lines.
import { RangeSetBuilder, Transaction, type EditorState, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

export interface ConflictBlock {
  /** 1-based line numbers. */
  start: number;
  base: number | null;
  mid: number;
  end: number;
}

const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const MID = /^={7}$/;
const END = /^>{7}(?: |$)/;

export function findConflicts(doc: Text): ConflictBlock[] {
  const out: ConflictBlock[] = [];
  let cur: Partial<ConflictBlock> | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    const t = doc.line(n).text;
    if (START.test(t)) cur = { start: n, base: null };
    else if (!cur) continue;
    else if (BASE.test(t) && cur.mid === undefined) cur.base = n;
    else if (MID.test(t) && cur.mid === undefined) cur.mid = n;
    else if (END.test(t) && cur.mid !== undefined) {
      out.push({ start: cur.start!, base: cur.base ?? null, mid: cur.mid, end: n });
      cur = null;
    }
  }
  return out;
}

export type Side = 'current' | 'incoming' | 'both';

/** The change that keeps one side (or both) of a conflict block. */
export function resolveChange(doc: Text, b: ConflictBlock, side: Side): { from: number; to: number; insert: string } {
  const lines = (from: number, to: number) => {
    const out: string[] = [];
    for (let n = from; n <= to; n++) out.push(doc.line(n).text);
    return out;
  };
  const ours = lines(b.start + 1, (b.base ?? b.mid) - 1);
  const theirs = lines(b.mid + 1, b.end - 1);
  const keep = side === 'current' ? ours : side === 'incoming' ? theirs : [...ours, ...theirs];
  const from = doc.line(b.start).from;
  const endLine = doc.line(b.end);
  if (keep.length) return { from, to: endLine.to, insert: keep.join('\n') };
  // Nothing kept: drop the block together with one line break.
  if (endLine.to < doc.length) return { from, to: endLine.to + 1, insert: '' };
  return { from: Math.max(0, from - 1), to: endLine.to, insert: '' };
}

class Actions extends WidgetType {
  constructor(readonly start: number) {
    super();
  }
  eq(o: Actions) {
    return o.start === this.start;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'se-git-cf-actions';
    const add = (label: string, side: Side) => {
      const b = wrap.appendChild(document.createElement('button'));
      b.type = 'button';
      b.className = `se-git-cf-btn ${side}`;
      b.textContent = label;
      b.disabled = view.state.readOnly;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        acceptConflict(view, this.start, side);
      });
    };
    add('Accept current', 'current');
    add('Accept incoming', 'incoming');
    add('Accept both', 'both');
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** Keep one side of the conflict block that starts on 1-based line `start`. */
export function acceptConflict(view: EditorView, start: number, side: Side): boolean {
  if (view.state.readOnly) return false;
  const b = findConflicts(view.state.doc).find((x) => x.start === start);
  if (!b) return false;
  view.dispatch({ changes: resolveChange(view.state.doc, b, side), annotations: [isolateHistory.of('full'), Transaction.userEvent.of('git.resolve')] });
  return true;
}

const line = (cls: string) => Decoration.line({ class: cls });
const MARK = line('se-git-cf-marker');
const OURS = line('se-git-cf-ours');
const BASE_L = line('se-git-cf-base');
const THEIRS = line('se-git-cf-theirs');

function build(state: EditorState): DecorationSet {
  const blocks = findConflicts(state.doc);
  const b = new RangeSetBuilder<Decoration>();
  for (const c of blocks) {
    for (let n = c.start; n <= c.end; n++) {
      const l = state.doc.line(n);
      const deco = n === c.start || n === c.mid || n === c.end || n === c.base ? MARK : n < (c.base ?? c.mid) ? OURS : n < c.mid ? BASE_L : THEIRS;
      b.add(l.from, l.from, deco);
      if (n === c.start) b.add(l.to, l.to, Decoration.widget({ widget: new Actions(c.start), side: 1 }));
    }
  }
  return b.finish();
}

/** Did an edit create a marker-looking line? (Without blocks there is nothing else to update.) */
function touchesMarker(u: ViewUpdate): boolean {
  let hit = false;
  u.changes.iterChangedRanges((_fa, _ta, fb, tb) => {
    const doc = u.state.doc;
    for (let n = doc.lineAt(fb).number, last = doc.lineAt(tb).number; n <= last && !hit; n++) {
      const t = doc.line(n).text;
      hit = START.test(t) || MID.test(t) || END.test(t);
    }
  });
  return hit;
}

export const conflictMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view.state);
    }
    update(u: ViewUpdate) {
      if (!u.docChanged) return;
      if (this.decorations.size || touchesMarker(u)) this.decorations = build(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);
