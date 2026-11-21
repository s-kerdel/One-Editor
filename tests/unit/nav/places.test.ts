// Recent-places list (right-click / long-press on the back / forward buttons): row labels.
import { describe, expect, it } from 'vitest';
import { describePlace } from '../../../src/renderer/nav/places';

const NOTE = ['---', 'title: x', '---', '# Intro', 'text', '```md', '# not a heading', '```', '## Install **now**', 'step', '', '### ' + 'Very long heading '.repeat(4)].join('\n');

describe('describePlace', () => {
  it('file name + the heading the line sits under, when the note text is at hand', () => {
    expect(describePlace({ path: 'notes/guide.md', line: 4 }, NOTE)).toEqual({ label: 'guide.md', hint: 'Intro' });
    expect(describePlace({ path: 'notes/guide.md', line: 6 }, NOTE).hint).toBe('Intro'); // inside a code fence
    expect(describePlace({ path: 'notes/guide.md', line: 9 }, NOTE).hint).toBe('Install now'); // inline markup stripped
    expect(describePlace({ path: 'notes/guide.md', line: 8 }, NOTE).hint).toBe('Install now'); // on the heading itself
  });

  it('falls back to the line (1-based): above the first heading, a closed note, a code file', () => {
    expect(describePlace({ path: 'guide.md', line: 1 }, NOTE).hint).toBe('line 2');
    expect(describePlace({ path: 'guide.md', line: 4 }).hint).toBe('line 5');
    expect(describePlace({ path: 'src/app.ts', line: 41 }, '# not markdown\n'.repeat(50))).toEqual({ label: 'app.ts', hint: 'line 42' });
  });

  it('PDF page; no spot at all; long headings are cut', () => {
    expect(describePlace({ path: 'docs/spec.pdf', page: 7 })).toEqual({ label: 'spec.pdf', hint: 'page 7' });
    expect(describePlace({ path: 'img/a.png' })).toEqual({ label: 'a.png', hint: '' });
    const long = describePlace({ path: 'guide.md', line: 11 }, NOTE).hint;
    expect(long.length).toBeLessThanOrEqual(36);
    expect(long.endsWith('…')).toBe(true);
  });
});
