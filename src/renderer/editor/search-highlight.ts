// Highlights matches of the workspace search in the active editor (EditorController.highlightSearch).
import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { SearchQuery } from '@codemirror/search';

export interface HighlightQuery {
  search: string;
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
}

export const setHighlightQuery = StateEffect.define<SearchQuery | null>();

export const highlightQueryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHighlightQuery)) v = e.value;
    return v;
  },
});

export function toSearchQuery(q: HighlightQuery | null): SearchQuery | null {
  if (!q || !q.search) return null;
  const sq = new SearchQuery({ search: q.search, caseSensitive: !!q.caseSensitive, regexp: !!q.regexp, wholeWord: !!q.wholeWord });
  return sq.valid ? sq : null;
}

const matchDeco = Decoration.mark({ class: 'se-search-hit' });
const MAX = 2000;

function build(view: EditorView): DecorationSet {
  const q = view.state.field(highlightQueryField, false);
  if (!q) return Decoration.none;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const cur = q.getCursor(view.state, Math.max(0, from - 500), Math.min(view.state.doc.length, to + 500));
    for (let r = cur.next(); !r.done && out.length < MAX; r = cur.next()) {
      if (r.value.to > r.value.from) out.push(matchDeco.range(r.value.from, r.value.to));
    }
  }
  return Decoration.set(out, true);
}

export const searchHighlighter = [
  highlightQueryField,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.startState.field(highlightQueryField, false) !== u.state.field(highlightQueryField, false)) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
];
