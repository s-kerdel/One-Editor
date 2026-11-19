// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { expandEmbeds, extractSection, invalidateEmbeds, stripFrontmatter, type EmbedContext } from '../../../src/renderer/preview/embeds';
import { renderCodeFile, renderMarkdown } from '../../../src/renderer/preview/markdown';

const NOTES: Record<string, string> = {
  'a.md': '# A\n\nfrom a\n\n![[b]]',
  'b.md': '---\ntitle: B\n---\n# B\n\nfrom b ^blk\n\n## Sub\n\nsub text\n\n```\n## not a heading\n```\n\n### Deeper\n\ndeep\n\n## Other\n\nother\n\n![[a]]',
  'self.md': 'me ![[self]]',
  'code/app.ts': 'export const x = 1;\n',
  'd1.md': '![[d2]]', 'd2.md': '![[d3]]', 'd3.md': '![[d4]]', 'd4.md': '![[d5]]', 'd5.md': '![[d6]]', 'd6.md': 'bottom',
};
const files = Object.keys(NOTES);
const ctx: EmbedContext = {
  read: async (p) => NOTES[p] ?? null,
  render: (src, path) => renderMarkdown(src, { path, files, sourceLines: false, frontmatter: false }),
  renderFile: renderCodeFile,
};
function host(src: string, path = 'root.md') {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(src, { path, files });
  return el;
}

describe('extractSection', () => {
  it('heading section up to the next heading of the same or higher level', () => {
    const s = extractSection(NOTES['b.md'], 'Sub')!;
    expect(s.startsWith('## Sub')).toBe(true);
    expect(s).toContain('## not a heading');
    expect(s).toContain('### Deeper');
    expect(s).not.toContain('## Other');
  });
  it('is case/punctuation tolerant and returns null when missing', () => {
    expect(extractSection('# Hello, World!\nx', 'hello world')).toBe('# Hello, World!\nx');
    expect(extractSection(NOTES['b.md'], 'Nope')).toBeNull();
  });
  it('block reference', () => {
    expect(extractSection(NOTES['b.md'], '^blk')).toBe('from b ^blk');
  });
  it('stripFrontmatter', () => {
    expect(stripFrontmatter('---\na: 1\n---\nbody')).toBe('body');
    expect(stripFrontmatter('no fm\n---\nx')).toBe('no fm\n---\nx');
  });
});

describe('expandEmbeds', () => {
  it('transcludes a note without its frontmatter', async () => {
    const el = host('before\n\n![[b]]\n\nafter');
    await expandEmbeds(el, ctx, ['root.md']);
    const e = el.querySelector('.se-embed.is-loaded')!;
    expect(e.querySelector('.se-embed-title a')!.textContent).toBe('b');
    expect(e.querySelector('.se-embed-body h1')!.textContent).toBe('B');
    expect(e.textContent).not.toContain('title: B');
    expect(e.querySelector('.se-embed-body [data-line]')).toBeNull(); // foreign lines must not confuse scroll sync
    expect(e.textContent).not.toContain('^blk');
  });
  it('transcludes a section and a block', async () => {
    const el = host('![[b#Sub]]\n\n![[b#^blk]]\n\n![[b#Missing]]');
    await expandEmbeds(el, ctx, ['root.md']);
    const [sec, blk, missing] = el.querySelectorAll('.se-embed');
    expect(sec.querySelector('.se-embed-body')!.textContent).toContain('sub text');
    expect(sec.querySelector('.se-embed-body')!.textContent).not.toContain('other');
    expect(blk.querySelector('.se-embed-body')!.textContent!.trim()).toBe('from b');
    expect(missing.classList.contains('is-missing-section')).toBe(true);
  });
  it('is cycle safe (a → b → a) and self-embed safe', async () => {
    const el = host(NOTES['a.md'], 'a.md');
    await expandEmbeds(el, ctx, ['a.md']);
    const b = el.querySelector('.se-embed.is-loaded')!;
    expect(b.getAttribute('data-path')).toBe('b.md');
    const back = b.querySelector('.se-embed-body .se-embed')!;
    expect(back.classList.contains('is-cycle')).toBe(true);
    expect(back.classList.contains('is-loaded')).toBe(false);
    const self = host(NOTES['self.md'], 'self.md');
    await expandEmbeds(self, ctx, ['self.md']);
    expect(self.querySelector('.se-embed')!.classList.contains('is-cycle')).toBe(true);
  });
  it('is depth limited', async () => {
    const el = host('![[d1]]');
    await expandEmbeds(el, ctx, ['root.md']);
    expect(el.querySelectorAll('.se-embed.is-loaded').length).toBe(4);
    expect(el.textContent).not.toContain('bottom');
    expect(el.querySelectorAll('.se-embed.is-cycle').length).toBe(1);
  });
  it('embeds code files as code blocks and leaves unreadable targets as links', async () => {
    const el = host('![[app.ts]]\n\n![[ghost]]');
    await expandEmbeds(el, ctx, ['root.md']);
    expect(el.querySelector('.se-embed.is-loaded .se-code')!.getAttribute('data-lang')).toBe('typescript');
    expect(el.querySelector('.se-embed.is-unresolved a')!.textContent).toBe('ghost');
  });
  it('refreshes after the source changes', async () => {
    const el = host('![[d6]]');
    await expandEmbeds(el, ctx, ['root.md']);
    expect(el.textContent).toContain('bottom');
    NOTES['d6.md'] = 'changed';
    expect(invalidateEmbeds(el, 'd6.md')).toBe(true);
    expect(invalidateEmbeds(el, 'unrelated.md')).toBe(false);
    await expandEmbeds(el, ctx, ['root.md']);
    expect(el.querySelector('.se-embed-body')!.textContent).toContain('changed');
    expect(el.querySelectorAll('.se-embed-title').length).toBe(1);
    NOTES['d6.md'] = 'bottom';
  });
});
