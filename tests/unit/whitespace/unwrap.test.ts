// Terminal copies without newlines (Windows Terminal: every row padded to the window width).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { trimPasted, unwrapTerminalRows } from '../../../src/renderer/whitespace/trim';

// The real clipboard from the bug report: 1132 chars, no \n / \r, rows of 280.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'terminal-padded.txt'), 'utf8');
const EXPECTED = '```yaml\nvars:                      # used in every environment\n  domain: corp.local\n  share: ADMIN$\n  port: 8080';

/** mulberry32: deterministic, well-spread. */
function seeded(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rows of `w` cells, each padded with spaces (the last one is not, like a terminal selection). */
const rows = (w: number, lines: string[]) => lines.map((l, i) => (i === lines.length - 1 ? l : l.padEnd(w, ' '))).join('');

describe('unwrapTerminalRows', () => {
  it('the reported clipboard → its lines (inner alignment spaces stay)', () => {
    expect(FIXTURE.length).toBe(1132);
    expect(FIXTURE).not.toMatch(/[\r\n]/);
    expect(trimPasted(FIXTURE)).toBe(EXPECTED);
  });

  it.each([80, 120, 280])('finds the row width (W = %i)', (w) => {
    const lines = ['$ kubectl get pods -n {{ns}}', 'NAME            READY   STATUS', 'web-7d9f        1/1     Running', '', '  indented line', 'done'];
    expect(unwrapTerminalRows(rows(w, lines))).toBe(lines.join('\n'));
  });

  it('a row full to the edge continues on the next one (soft wrap of one long line)', () => {
    const w = 80;
    const long = 'x'.repeat(w) + 'tail of the same line';
    const text = rows(w, ['first line', 'second', long.slice(0, w)]) + rows(w, [long.slice(w), 'after', 'end']);
    expect(trimPasted(text)).toBe(`first line\nsecond\n${long}\nafter\nend`);
  });

  it('mixed: newline-separated lines where some are padded rows; CRLF clipboards too', () => {
    const block = rows(100, ['a: 1', 'b: 2', 'c: 3']);
    expect(trimPasted(`intro   \n${block}\noutro  \n`)).toBe('intro\na: 1\nb: 2\nc: 3\noutro\n');
    expect(trimPasted(`intro\r\n${block}\r\n`)).toBe('intro\na: 1\nb: 2\nc: 3\n');
  });

  it('leaves normal long lines alone', () => {
    const table = `| ${'name'.padEnd(40)} | ${'value'.padEnd(40)} | ${'note'.padEnd(40)} |`;
    const aligned = 'const alpha        = 1;  const beta         = 2;  const gamma        = 3;  const delta        = 4;  // aligned';
    const minified = Array.from({ length: 200 }, (_, i) => `function f${i}(a){return a+${i}}`).join(';');
    const sentence = 'This is a long sentence that keeps going on and on, with commas, clauses and words, well past one hundred and sixty characters, without any padding at all.';
    const irregular = `start${' '.repeat(9)}one${' '.repeat(23)}two${' '.repeat(11)}three${' '.repeat(31)}four${' '.repeat(17)}five${' '.repeat(13)}six and the rest of the line`;
    for (const l of [table, aligned, minified, sentence, irregular]) {
      expect(unwrapTerminalRows(l), l.slice(0, 40)).toBe(l);
      expect(trimPasted(l).includes('\n'), l.slice(0, 40)).toBe(false);
    }
    expect(minified.length).toBeGreaterThan(2000);
  });

  it('property: random terminal pastes (W 40–300, sibling indents, alignment, blank lines) — never mangled', () => {
    const rnd = seeded(7);
    const word = () => 'abcdefghijklmnopqrstuvwxyz0123456789:-_./$'.split('').filter(() => rnd() < 0.3).join('') || 'x';
    let exact = 0;
    let total = 0;
    for (let t = 0; t < 400; t++) {
      const w = 40 + Math.floor(rnd() * 261);
      const lines: string[] = [];
      let indent = 0;
      for (let k = 3 + Math.floor(rnd() * 10); k > 0; k--) {
        if (rnd() < 0.1) {
          lines.push('');
          continue;
        }
        if (rnd() < 0.3) indent = [0, 2, 4][Math.floor(rnd() * 3)];
        let l = ' '.repeat(indent) + word();
        while (rnd() < 0.7 && l.length < w / 2) l += (rnd() < 0.1 ? ' '.repeat(2 + Math.floor(rnd() * 10)) : ' ') + word();
        lines.push(l.slice(0, w - 2).replace(/ +$/, ''));
      }
      while (!lines[lines.length - 1]) lines.pop(); // a selection ends on text
      if (lines.length < 3) continue;
      total++;
      const text = rows(w, lines);
      const out = trimPasted(text);
      if (out === lines.join('\n')) exact++;
      else if (out.includes('\n')) {
        // Unwrapped but not exact: only a staircase of indents is ambiguous (2,4,6 at W reads the same
        // as 0,0,0 at W+2) — lines and their text are still right, only indentation differs.
        expect(out.split('\n').map((l) => l.trim()), `W=${w}`).toEqual(lines.map((l) => l.trim()));
      } else expect(out, `W=${w}`).toBe(text.trimEnd()); // not detected: one right-trimmed line
    }
    expect(exact / total).toBeGreaterThan(0.95);
  });

  it('property: long prose / code lines with a few long space runs are never split', () => {
    const rnd = seeded(21);
    const WORDS = 'the quick brown fox jumps over lazy dog config value server deploy const let return function if else for while import export from await async null true false 10.0.0.1 kubectl apply -f'.split(' ');
    for (let t = 0; t < 1000; t++) {
      let l = '';
      const len = 120 + Math.floor(rnd() * 1900);
      while (l.length < len) l += ` ${WORDS[Math.floor(rnd() * WORDS.length)]}`;
      l = l.trim();
      for (let k = 2 + Math.floor(rnd() * 5); k > 0; k--) {
        const sp = l.indexOf(' ', Math.floor(rnd() * l.length));
        if (sp > 0) l = l.slice(0, sp) + ' '.repeat(8 + Math.floor(rnd() * 40)) + l.slice(sp + 1);
      }
      expect(unwrapTerminalRows(l), l.slice(0, 60)).toBe(l);
    }
  });

  it('a nested YAML block with siblings keeps its indentation', () => {
    const lines = ['envs:', '  lab:', '    vars:', '      ns: lab', '  prod:', '    vars:', '      ns: prod'];
    for (const w of [80, 120, 280]) expect(trimPasted(rows(w, lines)), `W=${w}`).toBe(lines.join('\n'));
    const block = ['  domain: corp.local', '  share: ADMIN$', '  port: 8080']; // every row indented
    for (const w of [80, 219, 280]) expect(trimPasted(rows(w, block)), `W=${w}`).toBe(block.join('\n'));
  });

  it('rows measured in UTF-16 units: a wide-char row (2 cells, 1 unit) does not line up → left as one line', () => {
    // Windows Terminal pads rows to W *cells*; "日本" takes 4 cells but 2 code units, so the row is short.
    const w = 80;
    const text = 'title'.padEnd(w) + '日本'.padEnd(w - 2) + 'last'.padEnd(w) + 'end';
    const out = trimPasted(text);
    expect(out.startsWith('title')).toBe(true);
    expect(out).not.toMatch(/ $/); // still right-trimmed
  });
});
