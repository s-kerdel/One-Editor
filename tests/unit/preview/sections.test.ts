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
function expectEquivalent(src: string) {
  const { sections, defs } = splitSections(src);
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
  it('mixed real-world document stays equivalent', () => {
    const src = `---\ntags: [a]\n---\n\n# Title${pad}\n\n> [!note] Callout\n> - [ ] task\n\n## Code\n\n\`\`\`php\n<?php\n# php comment\n\`\`\`\n\nSetext\n======\n\ntext #tag\n\n| a |\n|---|\n| 1 |\n### Table end\n\n    # indented code\n\n#nospace-tag\n\n#### Deep\n$$x$$\n# End\n`;
    expect(expectEquivalent(src)).toBeGreaterThan(4);
  });
});
