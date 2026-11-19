// The block-widget field updates incrementally (only blocks around edits / the selection are re-derived).
// Property test: after every random edit or cursor move it must equal a full recomputation.
import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownSupport } from '../../../src/renderer/editor/syntax';
import { blockField, computeBlocksForTest, setBlocksFocusedForTest } from '../../../src/renderer/editor/live';

const DOC = [
  '---', 'title: T', 'tags: [a]', '---', '', 'Intro para.', '',
  '| A | B |', '|---|---|', '| 1 | 2 |', '', 'Between.', '',
  '$$', 'x^2', '$$', '', '> [!note]- Folded', '> hidden body', '', '![[Other]]', '![[Third]]', '',
  '- item', '  | c | d |', '  |---|---|', '  | 3 | 4 |', '- item 2', '',
  '```mermaid', 'graph TD', 'A-->B', '```', '', 'End.',
].join('\n');

function snapshot(state: EditorState, decos = state.field(blockField).decos) {
  const out: string[] = [];
  decos.between(0, state.doc.length, (from, to, d) => void out.push(`${from}-${to}:${(d.spec.widget?.constructor?.name) ?? 'hide'}`));
  return out;
}

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('incremental block widgets', () => {
  it.each([7, 11, 23, 42, 99, 1234])('match a full rebuild after random edits and cursor moves (seed %i)', (seed) => {
    const r = rand(seed);
    let state = EditorState.create({ doc: DOC, extensions: [markdownSupport(), blockField] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    // Focused: the selection reveals blocks (setFocused is internal; flip via the field's focus flag).
    state = state.update({ effects: setBlocksFocusedForTest.of(true) }).state;
    expect(state.field(blockField).focused).toBe(true);
    const pieces = ['x', ' ', '\n', '|', '$$', '```', '> ', '- ', '![[N]]', '---', '\n\n', 'word '];
    for (let i = 0; i < 400; i++) {
      const len = state.doc.length;
      const pos = Math.floor(r() * (len + 1));
      let tr;
      if (r() < 0.35) tr = state.update({ selection: EditorSelection.cursor(pos) });
      else if (r() < 0.5 && pos < len) tr = state.update({ changes: { from: pos, to: Math.min(len, pos + 1 + Math.floor(r() * 4)) }, selection: EditorSelection.cursor(pos) });
      else {
        const ins = pieces[Math.floor(r() * pieces.length)];
        tr = state.update({ changes: { from: pos, insert: ins }, selection: EditorSelection.cursor(pos + ins.length) });
      }
      state = tr.state;
      ensureSyntaxTree(state, state.doc.length, 5000);
      const f = state.field(blockField);
      const full = computeBlocksForTest(state, f.window, f.toggled, f.focused);
      // Only compare where the tree was complete during the transaction (it is for this small doc).
      expect(snapshot(state), `step ${i}`).toEqual(snapshot(state, full.decos));
      expect([...f.tables].sort((a, b) => a - b), `tables step ${i}`).toEqual([...full.tables].sort((a, b) => a - b));
    }
  });
});
