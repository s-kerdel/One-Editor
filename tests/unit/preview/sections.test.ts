// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sectionSource, splitSections } from '../../../src/renderer/preview/sections';
import { renderMarkdown } from '../../../src/renderer/preview/markdown';

const pad = '\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(120); // push past the min split size
const starts = (src: string) => splitSections(src).sections.map((s) => s.start);
const textOf = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.querySelectorAll('[data-line]').forEach((n) => (n.removeAttribute('data-line'), n.removeAttribute('data-end')));
  return el.innerHTML.replace(/\s+/g, ' ').trim();
};
/** Rendering section by section must give the same document as rendering it whole. */
function expectEquivalent(src: string, soft?: { min: number; max: number }) {
  const { sections, defs } = splitSections(src, soft);
  expect(sections.map((s) => s.text).join('\n')).toBe(src);
  let line = 0;
  for (const s of sections) {
    expect(s.start).toBe(line);
    line += s.lines;
  }
  const parts = sections.map((s, i) => renderMarkdown(sectionSource(s, defs), { frontmatter: i === 0 }));
  expect(textOf(parts.join('\n'))).toBe(textOf(renderMarkdown(src)));
  return sections.length;
}

describe('splitSections', () => {
  it('keeps small documents whole', () => {
    expect(splitSections('# a\n\n# b').sections.length).toBe(1);
  });
  it('splits at ATX headings', () => {
    const src = `intro${pad}\n# One\ntext\n## Two\n\ntext\n###### Six\nend`;
    const n = expectEquivalent(src);
    expect(n).toBe(4);
  });
  it('never splits inside fenced code', () => {
    const src = `# A${pad}\n\`\`\`bash\n# not a heading\necho hi\n\`\`\`\n\n~~~~md\n# nope\n\`\`\`\n# still nope\n~~~~\n# B\n`;
    expect(expectEquivalent(src)).toBe(2);
  });
  it('handles fences inside lists and quotes that end with their container', () => {
    const src = `# A${pad}\n- item\n  \`\`\`sh\n  # comment in list fence\n# Real heading ends the list\n\ntext\n\n> \`\`\`\n> # quoted code\n# After quote\n\n1. x\n\n   \`\`\`\n   # code\n   \`\`\`\n# Last\n`;
    expect(expectEquivalent(src)).toBe(4);
  });
  it('an indented closing fence in a list does not invert the state', () => {
    const src = `# A${pad}\n- \`\`\`js\n  let a;\n  \`\`\`\n\n\`\`\`bash\n# comment, not heading\n\`\`\`\n# B\n`;
    expect(expectEquivalent(src)).toBe(2);
  });
  it('never splits inside html blocks, math, comments or frontmatter', () => {
    const src = `---\ntitle: x\n# yaml comment\n---\n# A${pad}\n<pre>\n# in pre\n\n# still pre\n</pre>\n\n<div>\n# in div\n</div>\n\n$$\n# in math\n$$\n\n%%\n# in comment\n\n# too\n%%\n\n<!--\n# html comment\n-->\n# B\n`;
    expect(expectEquivalent(src)).toBe(3); // frontmatter | A | B
  });
  it('unterminated fence swallows the rest', () => {
    const src = `# A${pad}\n# B\n\`\`\`\n# code\n# more code\n`;
    const { sections } = splitSections(src);
    expect(sections.length).toBe(2);
    expect(sections[1].open).toBe(true);
    expectEquivalent(src);
  });
  it('footnotes disable splitting; reference definitions are shared', () => {
    expect(splitSections(`# A${pad}\nx[^1]\n# B\n\n[^1]: note`).sections.length).toBe(1);
    const src = `# A${pad}\nSee [the site][site].\n# B\n\n[site]: https://example.com "Title"\n`;
    expect(splitSections(src).defs).toContain('[site]: https://example.com');
    expectEquivalent(src);
  });
  it('line numbers are continuous', () => {
    expect(starts(`a${pad}\n# b\n\n# c`)).toEqual([0, 241, 243]);
  });
  // Soft cuts: long stretches without headings split at neutral paragraph starts (huge notes stay progressive).
  const tricky = (i: number) =>
    [
      `Paragraph ${i} with **bold**, a [ref][r${i % 3}] and a [[wiki ${i}]] link that runs on like prose does.`,
      `1. loose item ${i}\n\n2. second\n\n3.\n\n   indented continuation of 3`,
      `- bullet\n\n  - nested after blank\n\n- back`,
      `Text right after a list ends it ${i}.`,
      `> [!note] Callout ${i}\n> line\n>\n> after a quoted blank`,
      `> plain quote\n\n> second quote`,
      `| a | b |\n|---|---|\n| ${i} | x |`,
      '```ts\nconst a = 1;\n\n\nconst b = 2; // blank lines inside the fence\n```',
      `- item with a fence\n\n  \`\`\`\n  code\n\n  more code\n  \`\`\`\n\nafter the list`,
      `$$\na = b\n\nc = d\n$$`,
      `<pre>\nraw\n\nstill raw\n</pre>`,
      `<div>\nhtml block\n</div>`,
      `%% comment\n\nstill comment %%`,
      `Setext ${i}\n======`,
      `    indented code\n\n    more indented`,
      `***`,
      `*emphasis start* and \\escaped and "quoted" and (parens) ${i}`,
      `[r${i % 3}]: https://example.com/${i % 3}`,
    ].join('\n\n');
  const headingless = (size: number) => {
    let src = 'Intro line.';
    for (let i = 0; src.length < size; i++) src += '\n\n' + tricky(i);
    return src + '\n';
  };

  it('splits long heading-less documents at neutral paragraph starts, rendering the same', () => {
    expect(expectEquivalent(headingless(60_000))).toBeGreaterThan(3);
  });

  it('every soft-cut candidate is neutral (cut at all of them: still the same document)', () => {
    expect(expectEquivalent(headingless(30_000), { min: 0, max: 0 })).toBeGreaterThan(200);
  });

  it('soft cuts keep sections bounded and are stable under edits (typing re-renders one section)', () => {
    const src = headingless(400_000);
    const a = splitSections(src).sections;
    expect(Math.max(...a.map((s) => s.text.length))).toBeLessThan(40_000);
    expect(a.length).toBeGreaterThan(400_000 / 40_000);
    const mid = src.indexOf('Paragraph 150 ');
    expect(mid).toBeGreaterThan(0);
    for (const edit of [(t: string) => t.slice(0, mid) + 'typed ' + t.slice(mid), (t: string) => t.slice(0, mid) + 'A new paragraph.\n\n' + t.slice(mid)]) {
      const b = splitSections(edit(src)).sections;
      const old = new Set(a.map((s) => s.text));
      expect(b.filter((s) => !old.has(s.text)).length, 'sections changed by one edit').toBeLessThanOrEqual(2);
    }
  });

  it('mixed real-world document stays equivalent', () => {
    const src = `---\ntags: [a]\n---\n\n# Title${pad}\n\n> [!note] Callout\n> - [ ] task\n\n## Code\n\n\`\`\`php\n<?php\n# php comment\n\`\`\`\n\nSetext\n======\n\ntext #tag\n\n| a |\n|---|\n| 1 |\n### Table end\n\n    # indented code\n\n#nospace-tag\n\n#### Deep\n$$x$$\n# End\n`;
    expect(expectEquivalent(src)).toBeGreaterThan(4);
  });
});
