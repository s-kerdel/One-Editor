// .gitignore patterns without a RegExp (audit M1): a hostile .gitignore (`a*a*…*b` + a long name, or a line of
// a million spaces) froze Electron main, so every window hung. The matcher must agree with the regex form it
// replaced on ordinary patterns and stay fast on crafted ones. (`git check-ignore` agreement: index-pass.test.ts.)
import { describe, expect, it } from 'vitest';
import { IgnoreStack, globMatcher, parseIgnoreLine } from '../../../src/backend/gitignore';

/** The regex form the matcher replaced (reference only; never run on crafted input here). */
function regexOf(glob: string, anchored: boolean, fold: boolean): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          i++;
          if (glob[i + 1] === '/') {
            i++;
            out += '(?:.*/)?';
          } else out += '.*';
          continue;
        }
      }
      while (glob[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '\\' && i + 1 < glob.length) out += esc(glob[++i]);
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) out += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else out += esc(c);
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`, fold ? 'i' : '');
}

const GLOBS: Array<[string, boolean]> = [
  ['*.log', false], ['build', false], ['docs/**/draft.md', true], ['**/tmp', true], ['a/**', true], ['x?z.md', false], ['[ab]c.md', false],
  ['[!ab]c.md', false], ['[a-c]*.txt', false], ['logs/*.txt', true], ['#hash.md', false], ['spaced ', false], ['*', false], ['**/*.min.js', true],
  ['a/**/b/**/c', true], ['Build', false], ['node_modules', false], ['*.[oa]', false], ['foo\\*bar', false], ['**/**/x', true], ['a*b*c', false], ['dir/', false],
];
const PATHS = [
  'a.log', 'sub/b.log', 'build', 'sub/build', 'build.md', 'docs/draft.md', 'docs/a/b/draft.md', 'tmp', 'z/tmp', 'a/b/c.md', 'a', 'xyz.md', 'xz.md', 'ac.md',
  'cc.md', 'bc.md', 'Ac.md', 'b1.txt', 'd.txt', 'logs/a.txt', 'logs/sub/a.txt', '#hash.md', 'spaced ', 'x', 'q/w/e', 'lib/x.min.js', 'x.min.js',
  'a/b/c', 'a/x/b/y/c', 'a/b/x/c', 'BUILD', 'Build', 'sub/BUILD', 'node_modules', 'node_modules/x', 'm.o', 'm.a', 'm.c', 'foo*bar', 'fooxbar', 'x', 'q/x',
  'aXbYc', 'abc', 'acb', 'dir', 'dir/', 'café.LOG', 'ÄC.MD',
];

describe('the matcher agrees with the regex form', () => {
  it('ordinary patterns, with and without case folding', () => {
    for (const fold of [false, true])
      for (const [glob, anchored] of GLOBS) {
        const m = globMatcher(glob, anchored, fold)!;
        const re = regexOf(glob, anchored, fold);
        for (const p of PATHS) expect(m(p), `${glob} ~ ${p} (fold ${fold})`).toBe(re.test(p));
      }
  });

  it('an invalid class drops the rule, as the regex did', () => {
    expect(parseIgnoreLine('[z-a].md', false)).toBeNull();
    expect(parseIgnoreLine('[a-z].md', false)?.test('q.md')).toBe(true);
  });

  it('trailing spaces: dropped unless escaped (the last escaped one stays); trailing slashes: a folder rule', () => {
    expect(parseIgnoreLine('name   ', false)?.glob).toBe('name');
    expect(parseIgnoreLine('name\\ ', false)?.glob).toBe('name\\ ');
    expect(parseIgnoreLine('name\\   ', false)?.glob).toBe('name\\ ');
    expect(parseIgnoreLine('name\t \r', false)?.glob).toBe('name');
    expect(parseIgnoreLine('    ', false)).toBeNull();
    expect(parseIgnoreLine('out///', false)).toMatchObject({ glob: 'out', dirOnly: true });
  });

  it('a stack sent from the worker (toJSON → fromJSON) decides the same', () => {
    const st = new IgnoreStack(true);
    st.add('', '*.log\n!keep.log\nbuild/\n/root.txt\ndocs/**/draft.md\n');
    st.add('sub', 'local.md\n');
    const back = IgnoreStack.fromJSON(JSON.parse(JSON.stringify(st.toJSON())), true);
    for (const [p, dir] of [['a.log', false], ['keep.log', false], ['x/build', true], ['x/build/y.md', false], ['root.txt', false], ['q/root.txt', false], ['docs/a/draft.md', false], ['sub/local.md', false], ['local.md', false], ['A.LOG', false]] as const)
      expect(back.ignored(p, dir), p).toBe(st.ignored(p, dir));
    expect(back.ignored('A.LOG')).toBe(true);
    expect(back.ignored('keep.log')).toBe(false);
  });
});

describe('crafted .gitignore lines finish fast', () => {
  it('a*a*a*…*b against a long name (the regex form backtracked exponentially)', () => {
    const st = new IgnoreStack(false);
    st.add('', `${'a*'.repeat(40)}b\n/${'a*'.repeat(40)}b\n${'[a]*'.repeat(40)}b\n`);
    const long = 'a'.repeat(4000);
    const t = performance.now();
    expect(st.ignored(long)).toBe(false);
    expect(st.ignored(`dir/${long}`)).toBe(false);
    expect(st.ignored(`${long}/x`, false)).toBe(false);
    expect(st.ignored(`${'a'.repeat(100)}b`)).toBe(true);
    // The literal end matches here, so the scan itself runs (no shortcut): still linear.
    const scan = new IgnoreStack(true);
    scan.add('', `${'a*'.repeat(40)}b*c\n${'?*'.repeat(40)}/c\n`);
    expect(scan.ignored(`${long}c`)).toBe(false);
    expect(scan.ignored(`${long}bc`)).toBe(true);
    expect(scan.ignored(`${long}/${long}/c`)).toBe(false);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('**/ chains and a huge pattern line', () => {
    const st = new IgnoreStack(true);
    st.add('', `${'**/'.repeat(50_000)}x\n${'*a'.repeat(100_000)}\n`);
    const t = performance.now();
    expect(st.ignored(`${'d/'.repeat(500)}x`)).toBe(true);
    expect(st.ignored(`${'d/'.repeat(500)}y`)).toBe(false);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('a line of spaces or slashes that does not end there (quadratic trailing-space / slash regexes)', () => {
    const t = performance.now();
    expect(parseIgnoreLine(`${' '.repeat(300_000)}x`, false)?.glob).toBe(`${' '.repeat(300_000)}x`);
    expect(parseIgnoreLine(`${'/'.repeat(300_000)}x/`, false)).toMatchObject({ dirOnly: true, anchored: true });
    expect(parseIgnoreLine(`x${'\\ '.repeat(150_000)}`, false)).not.toBeNull();
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
