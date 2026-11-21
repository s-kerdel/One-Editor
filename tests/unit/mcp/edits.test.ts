// Pure text edits behind append_file / patch_file / replace_text (src/mcp/edits.ts).
import { describe, expect, it } from 'vitest';
import { appendText, patchText, replaceUnique } from '../../../src/mcp/edits';
import { ToolError } from '../../../src/mcp/protocol';

const NOTE = ['---', 'title: N', 'tags: [a, b]', '---', '# Top', '', 'intro', '', '## Plans', '', '### 2026', 'plan', '', '```md', '## fake', '```', '', '## Other', 'para one', 'para two ^p1', '', '- item ^li', '  - child', '- next', ''].join('\n');
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof ToolError ? e.code : String(e);
  }
};

describe('appendText', () => {
  it('end: one newline between; start: after the frontmatter', () => {
    expect(appendText('a', 'b', 'end')).toBe('a\nb\n');
    expect(appendText('a\n', 'b\n\n', 'end')).toBe('a\nb\n');
    expect(appendText('', 'b', 'end')).toBe('b\n');
    expect(appendText('---\nx: 1\n---\nbody\n', 'top', 'start')).toBe('---\nx: 1\n---\ntop\nbody\n');
    expect(appendText('body\n', 'top', 'start')).toBe('top\nbody\n');
  });
});

describe('replaceUnique', () => {
  it('exactly one match, else a clear error with the count', () => {
    expect(replaceUnique('a b c', 'b', 'B')).toBe('a B c');
    expect(replaceUnique('a b c', ' b', '')).toBe('a c');
    expect(code(() => replaceUnique('a b c', 'x', 'y'))).toBe('ENOMATCH');
    expect(code(() => replaceUnique('aa a', 'a', 'y'))).toBe('EAMBIGUOUS');
    expect(() => replaceUnique('a a a', 'a', 'y')).toThrow(/occurs 3 times/);
    expect(code(() => replaceUnique('a', '', 'y'))).toBe('EINVAL');
  });
});

describe('patchText: headings', () => {
  it('append at the end of the section (after subsections), prepend after the heading line', () => {
    const a = patchText(NOTE, { heading: 'Plans' }, 'append', 'added');
    expect(a.split('\n').indexOf('added')).toBe(a.split('\n').indexOf('```') + 1);
    const p = patchText(NOTE, { heading: 'Plans > 2026' }, 'prepend', 'first');
    expect(p).toContain('### 2026\nfirst\nplan');
  });

  it('replace keeps the heading line; delete removes the section and its blank tail', () => {
    const r = patchText(NOTE, { heading: '2026' }, 'replace', 'new plan');
    expect(r).toContain('### 2026\nnew plan\n\n## Other');
    expect(r).not.toContain('## fake'); // the code block was in the section
    const d = patchText(NOTE, { heading: 'Plans' }, 'delete', '');
    expect(d).not.toContain('Plans');
    expect(d).toContain('intro\n\n## Other');
  });

  it('a "heading" inside a code fence is not a target; missing headings can be created', () => {
    expect(code(() => patchText(NOTE, { heading: 'fake' }, 'append', 'x'))).toBe('ENOENT');
    const c = patchText(NOTE, { heading: 'Plans > 2027' }, 'append', 'later', { createTarget: true });
    expect(c).toContain('### 2027\nlater');
    expect(c.indexOf('### 2027')).toBeLessThan(c.indexOf('## Other'));
    const top = patchText('# A\n', { heading: 'Ideas' }, 'append', 'x', { createTarget: true });
    expect(top).toBe('# A\n\n## Ideas\nx\n');
    expect(code(() => patchText(NOTE, { heading: 'Nope' }, 'delete', '', { createTarget: true }))).toBe('ENOENT');
  });
});

describe('patchText: blocks', () => {
  it('replace keeps the ^id (links keep working); append / prepend / delete', () => {
    expect(patchText(NOTE, { block: '^p1' }, 'replace', 'one paragraph')).toContain('## Other\none paragraph ^p1\n');
    expect(patchText(NOTE, { block: 'p1' }, 'replace', 'mine ^p1')).toContain('mine ^p1\n');
    expect(patchText(NOTE, { block: 'li' }, 'append', '- inserted')).toContain('  - child\n- inserted\n- next');
    expect(patchText(NOTE, { block: 'li' }, 'prepend', 'before')).toContain('before\n- item ^li');
    const d = patchText(NOTE, { block: 'li' }, 'delete', '');
    expect(d).not.toContain('item ^li');
    expect(d).not.toContain('child');
    expect(d).toContain('- next');
  });
});

describe('patchText: frontmatter', () => {
  it('replace sets (or adds) a key; append / prepend add list items; delete removes it', () => {
    expect(patchText(NOTE, { frontmatter_key: 'title' }, 'replace', 'New')).toContain('title: New\n');
    expect(patchText(NOTE, { frontmatter_key: 'status' }, 'replace', 'done')).toContain('tags: [a, b]\nstatus: done\n---');
    expect(patchText(NOTE, { frontmatter_key: 'tags' }, 'append', 'c')).toContain('tags:\n  - a\n  - b\n  - c\n---');
    expect(patchText(NOTE, { frontmatter_key: 'tags' }, 'prepend', 'z')).toContain('tags:\n  - z\n  - a');
    expect(patchText(NOTE, { frontmatter_key: 'title' }, 'delete', '')).not.toContain('title');
    expect(patchText('body\n', { frontmatter_key: 'status' }, 'replace', 'x')).toBe('---\nstatus: x\n---\nbody\n');
    expect(code(() => patchText(NOTE, { frontmatter_key: 'nope' }, 'append', 'x'))).toBe('ENOENT');
    expect(code(() => patchText(NOTE, { frontmatter_key: 'title' }, 'replace', 'a\nb'))).toBe('EINVAL');
    expect(code(() => patchText(NOTE, { frontmatter_key: 'bad:key' }, 'replace', 'x'))).toBe('EINVAL');
  });
});
