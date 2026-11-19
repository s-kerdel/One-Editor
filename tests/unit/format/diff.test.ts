import { describe, it, expect } from 'vitest';
import { minimalChanges, applyChanges, mapCursor } from '../../../src/format';

describe('minimalChanges', () => {
  const check = (a: string, b: string) => {
    const ch = minimalChanges(a, b);
    expect(applyChanges(a, ch)).toBe(b);
    for (let i = 1; i < ch.length; i++) expect(ch[i].from).toBeGreaterThanOrEqual(ch[i - 1].to);
    return ch;
  };
  it('returns nothing for equal texts', () => expect(minimalChanges('a\nb', 'a\nb')).toEqual([]));
  it('produces small separate hunks', () => {
    const a = 'line1\nfoo( a )\nline3\nline4\nbar( b )\nline6\n';
    const b = 'line1\nfoo(a)\nline3\nline4\nbar(b)\nline6\n';
    const ch = check(a, b);
    expect(ch).toHaveLength(2);
    expect(ch[0]).toEqual({ from: 10, to: 13, insert: 'a' });
  });
  it('handles inserts, deletes, empty sides and missing trailing newline', () => {
    check('', 'abc\n');
    check('abc\n', '');
    check('a\nb\nc', 'a\nc');
    check('a\nc', 'a\nb\nc\n');
    check('x', 'y');
    check('same\nsame\nsame\n', 'same\nsame\n');
    check('{"a":1,"b":[1,2]}', '{\n  "a": 1,\n  "b": [1, 2]\n}\n');
  });
  it('survives random edits', () => {
    let seed = 42;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let t = 0; t < 200; t++) {
      const mk = () => Array.from({ length: rnd(12) }, () => 'abc'[rnd(3)].repeat(rnd(3))).join('\n');
      check(mk(), mk());
    }
  });
  it('falls back to one hunk for huge diffs', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    expect(check(a, b)).toHaveLength(1);
  });
});

describe('mapCursor', () => {
  it('follows non-whitespace characters through rewritten hunks', () => {
    const a = 'if(x){foo( bar )}';
    const b = 'if (x) {\n  foo(bar);\n}\n';
    const at = mapCursor(a, b, a.indexOf('bar'));
    expect(b.slice(at - 1, at + 3)).toBe('(bar');
    expect(mapCursor(a, b, 0)).toBe(0);
    expect(mapCursor(a, b, a.length)).toBeLessThanOrEqual(b.length);
  });
  it('shifts offsets after an earlier change', () => {
    const a = 'a  =  1\nkeep me\n';
    const b = 'a = 1\nkeep me\n';
    expect(mapCursor(a, b, a.indexOf('me'))).toBe(b.indexOf('me'));
  });
});

describe('CodeMirror compatibility', () => {
  it('changes apply as one CodeMirror transaction and map the cursor', async () => {
    const { EditorState } = await import('@codemirror/state');
    const { formatText } = await import('../../../src/format');
    const src = '<?php\nclass A {\npublic function a(){ return 1; }\n    public function keep()\n    {\n        return 2;\n    }\nfunction b( $x ){return $x;}\n}\n';
    const cursor = src.indexOf('$x;');
    const r = await formatText(src, { path: 'a.php', cursorOffset: cursor });
    const changes = minimalChanges(src, r.text);
    expect(changes.length).toBeGreaterThan(1);
    const state = EditorState.create({ doc: src });
    const tr = state.update({ changes, selection: { anchor: r.cursorOffset! } });
    expect(tr.state.doc.toString()).toBe(r.text);
    expect(r.text.slice(tr.state.selection.main.head, tr.state.selection.main.head + 3)).toBe('$x;');
  });
});
