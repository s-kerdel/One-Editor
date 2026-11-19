import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { closeFenceOnEnter, thirdBacktick } from '../../../src/renderer/editor/mdkeys';
import { mdState, run, show } from './helpers';

function type(state: EditorState, text: string): EditorState {
  for (const ch of text) {
    const pos = state.selection.main.head;
    const spec = ch === '`' ? thirdBacktick(state, pos) : null;
    state = spec ? state.update(spec).state : state.update({ changes: { from: pos, insert: ch }, selection: EditorSelection.cursor(pos + 1) }).state;
    ensureSyntaxTree(state, state.doc.length, 5000);
  }
  return state;
}
const newline = (state: EditorState) => {
  const r = run(state, closeFenceOnEnter);
  if (r.handled) return r.state;
  const pos = state.selection.main.head;
  const next = state.update({ changes: { from: pos, insert: '\n' }, selection: EditorSelection.cursor(pos + 1) }).state;
  ensureSyntaxTree(next, next.doc.length, 5000);
  return next;
};

describe('closing a fenced code block by hand', () => {
  it('types over the auto-inserted closing fence (QA journey regression)', () => {
    let s = mdState('‸');
    s = type(s, '```bash');
    s = newline(s);
    expect(show(s)).toBe('```bash\n‸\n```');
    s = type(s, 'ls -la');
    s = newline(s);
    s = type(s, '```');
    expect(show(s)).toBe('```bash\nls -la\n```‸');
    s = newline(s);
    s = newline(s);
    s = type(s, 'after');
    expect(s.doc.toString()).toBe('```bash\nls -la\n```\n\nafter');
  });

  it('also swallows blank lines between the typed fence and the auto one', () => {
    const s = mdState('```js\nx\n``‸\n\n```\nrest');
    const spec = thirdBacktick(s, s.selection.main.head)!;
    expect(show(s.update(spec).state)).toBe('```js\nx\n```‸\nrest');
  });

  it('leaves the closing fence alone when code follows the typed fence', () => {
    const s = mdState('```js\nx\n``‸\ny\n```');
    const spec = thirdBacktick(s, s.selection.main.head)!;
    expect(show(s.update(spec).state)).toBe('```js\nx\n```‸\ny\n```');
  });

  it('a fence opened outside any block is just normalised', () => {
    const s = mdState('text\n\n``‸``');
    const spec = thirdBacktick(s, s.selection.main.head)!;
    expect(show(s.update(spec).state)).toBe('text\n\n```‸');
  });

  it('does not type over a longer (````) or differently indented fence', () => {
    const a = mdState('````md\nx\n``‸\n````');
    expect(show(a.update(thirdBacktick(a, a.selection.main.head)!).state)).toBe('````md\nx\n```‸\n````');
    const b = mdState('- item\n\n  ```js\n  x\n``‸\n  ```');
    expect(show(b.update(thirdBacktick(b, b.selection.main.head)!).state)).toContain('```‸\n  ```');
  });
});
