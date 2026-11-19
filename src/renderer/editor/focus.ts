// Writing aids for Markdown: focus mode (dim everything but the block being edited) and typewriter
// scrolling (the cursor line stays vertically centred while typing / moving with the keyboard).
import { EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

const ON = Decoration.line({ class: 'se-focus-on' });
const MAX_LINES = 400;

/** Line range of the block around `pos`: the innermost list item (without its sub-list) or the top-level block. */
export function focusRange(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  let block: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'ListItem') {
      block = n;
      break;
    }
    if (n.parent?.name === 'Document') {
      block = n;
      break;
    }
  }
  const line = doc.lineAt(pos);
  if (!block || !line.text.trim()) return { from: line.from, to: line.to };
  let to = block.to;
  if (block.name === 'ListItem') {
    const sub = block.getChild('BulletList') ?? block.getChild('OrderedList');
    if (sub && sub.from > pos) to = Math.max(block.from, doc.lineAt(sub.from).from - 1);
  }
  const a = doc.lineAt(Math.min(block.from, pos));
  const b = doc.lineAt(Math.max(Math.min(to, doc.length), pos));
  return { from: a.from, to: b.number - a.number > MAX_LINES ? line.to : b.to };
}

function build(view: EditorView): DecorationSet {
  if (!view.hasFocus) return Decoration.none;
  const { state } = view;
  const r = focusRange(state, state.selection.main.head);
  const out: Range<Decoration>[] = [];
  for (let pos = r.from; pos <= r.to; ) {
    const line = state.doc.lineAt(pos);
    out.push(ON.range(line.from));
    pos = line.to + 1;
  }
  return Decoration.set(out);
}

export const focusMode: Extension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.editorAttributes.of({ class: 'se-focus-mode' }),
];

export const typewriter: Extension = [
  // Keyboard edits and moves re-centre the cursor line; pointer selections never scroll.
  EditorState.transactionExtender.of((tr) => {
    if (!tr.docChanged && !tr.selection) return null;
    if (!(tr.isUserEvent('input') || tr.isUserEvent('delete') || (tr.isUserEvent('select') && !tr.isUserEvent('select.pointer')))) return null;
    return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: 'center' }) };
  }),
  EditorView.editorAttributes.of({ class: 'se-typewriter' }),
];
