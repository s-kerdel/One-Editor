import { describe, it, expect } from 'vitest';
import { toggleLineKind, formatState } from '../../../src/renderer/editor/format';
import { focusRange } from '../../../src/renderer/editor/focus';
import { apply, mdState } from './helpers';

describe('toggleLineKind (toolbar list / quote buttons)', () => {
  it('adds and removes bullets, keeping the cursor after the marker', () => {
    expect(apply('‸item', toggleLineKind('bullet'))).toBe('- ‸item');
    expect(apply('- it‸em', toggleLineKind('bullet'))).toBe('it‸em');
  });
  it('switches between list kinds instead of stacking markers', () => {
    expect(apply('- it‸em', toggleLineKind('ordered'))).toBe('1. it‸em');
    expect(apply('1. it‸em', toggleLineKind('task'))).toBe('- [ ] it‸em');
    expect(apply('- [x] it‸em', toggleLineKind('task'))).toBe('it‸em');
    expect(apply('- [ ] it‸em', toggleLineKind('bullet'))).toBe('- it‸em');
  });
  it('numbers selected lines and skips blank ones', () => {
    expect(apply('«a\n\nb\nc»', toggleLineKind('ordered'))).toBe('«1. a\n\n2. b\n3. c»');
  });
  it('keeps indentation and works inside quotes', () => {
    expect(apply('  ‸nested', toggleLineKind('bullet'))).toBe('  - ‸nested');
    expect(apply('> ‸quoted', toggleLineKind('task'))).toBe('> - [ ] ‸quoted');
  });
  it('quotes wrap lists and toggle off', () => {
    expect(apply('«- a\n- b»', toggleLineKind('quote'))).toBe('«> - a\n> - b»');
    expect(apply('«> a\n> b»', toggleLineKind('quote'))).toBe('«a\nb»');
  });
});

describe('formatState (toolbar active states)', () => {
  const st = (marked: string) => formatState(mdState(marked));
  it('inline marks light up strictly inside the markup', () => {
    expect(st('a **bo‸ld** b').bold).toBe(true);
    expect(st('a **bold**‸ b').bold).toBe(false);
    expect(st('a *it‸* b').italic).toBe(true);
    expect(st('~~s‸~~').strike).toBe(true);
    expect(st('==h‸==').highlight).toBe(true);
    expect(st('`c‸`').code).toBe(true);
    expect(st('[te‸xt](u)').link).toBe(true);
    expect(st('a «**bold**» b').bold).toBe(true);
  });
  it('reports heading level and block kinds', () => {
    expect(st('## He‸ad').heading).toBe(2);
    expect(st('plain‸').heading).toBe(0);
    expect(st('- it‸em').bullet).toBe(true);
    expect(st('1. it‸em').ordered).toBe(true);
    const task = st('- [ ] ta‸sk');
    expect([task.task, task.bullet]).toEqual([true, false]);
    expect(st('> quo‸te').quote).toBe(true);
    const callout = st('> [!note] Ti‸tle\n> body');
    expect([callout.callout, callout.quote]).toEqual([true, false]);
    expect(st('```js\nco‸de\n```').codeBlock).toBe(true);
    expect(st('| a | b |\n|---|---|\n| 1‸ | 2 |').table).toBe(true);
    expect(st('$$\nx‸\n$$').math).toBe(true);
  });
});

describe('focusRange (focus mode)', () => {
  it('is the current paragraph, or the list item without its sub-list', () => {
    const s = mdState('para one\nstill one‸\n\npara two');
    expect(s.sliceDoc(focusRange(s, s.selection.main.head).from, focusRange(s, s.selection.main.head).to)).toBe('para one\nstill one');
    const l = mdState('- a\n- b‸\n  - c\n- d');
    const r = focusRange(l, l.selection.main.head);
    expect(l.sliceDoc(r.from, r.to)).toBe('- b');
  });
});
