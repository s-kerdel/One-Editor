// Test helpers: build a Markdown EditorState from a doc with cursor/selection markers and run commands.
//   "‸" = cursor, "«…»" = selection (anchor at «, head at »).
import { EditorState, EditorSelection, type StateCommand, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownSupport } from '../../../src/renderer/editor/syntax';
import { autoRenumber } from '../../../src/renderer/editor/lists';

export function mdState(marked: string, extra: Extension[] = []): EditorState {
  const ranges: Array<{ anchor: number; head: number }> = [];
  let doc = '';
  let anchor = -1;
  for (const ch of marked) {
    if (ch === '‸') ranges.push({ anchor: doc.length, head: doc.length });
    else if (ch === '«') anchor = doc.length;
    else if (ch === '»') ranges.push({ anchor, head: doc.length });
    else doc += ch;
  }
  const selection = ranges.length ? EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head))) : undefined;
  const state = EditorState.create({ doc, selection, extensions: [markdownSupport(), EditorState.allowMultipleSelections.of(true), autoRenumber, ...extra] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** Doc with the main selection re-inserted as markers (for compact assertions). */
export function show(state: EditorState): string {
  const doc = state.doc.toString();
  const ins: Array<[number, string]> = [];
  for (const r of state.selection.ranges) {
    if (r.empty) ins.push([r.head, '‸']);
    else {
      ins.push([r.anchor, '«']);
      ins.push([r.head, '»']);
    }
  }
  ins.sort((a, b) => b[0] - a[0] || (a[1] === '«' ? 1 : -1));
  let out = doc;
  for (const [pos, m] of ins) out = out.slice(0, pos) + m + out.slice(pos);
  return out;
}

/** Run a StateCommand; returns the new state (or the same state if it didn't apply) and whether it ran. */
export function run(state: EditorState, cmd: StateCommand): { state: EditorState; handled: boolean } {
  let next = state;
  const handled = cmd({
    state,
    dispatch: (tr) => {
      next = tr.state;
      ensureSyntaxTree(next, next.doc.length, 5000);
    },
  });
  return { state: next, handled };
}

export const apply = (marked: string, cmd: StateCommand) => show(run(mdState(marked), cmd).state);
