// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CALLOUT_TYPES, parseFrontmatter, renderMarkdown, slugify } from '../../../src/renderer/preview/markdown';

const FILES = ['README.md', 'notes/Daily notes.md', 'notes/kubernetes.md', 'assets/pic.png', 'code/app.ts'];
function dom(src: string, opts: Parameters<typeof renderMarkdown>[1] = {}) {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(src, { files: FILES, path: 'notes/Daily notes.md', ...opts });
  return el;
}

describe('callouts', () => {
  it('renders every standard type with icon, title and content', () => {
    for (const type of CALLOUT_TYPES) {
      const el = dom(`> [!${type}] My title\n> Body **text**`);
      const c = el.querySelector('.se-callout')!;
      expect(c, type).toBeTruthy();
      expect(c.getAttribute('data-callout')).toBe(type);
      expect(c.tagName).toBe('DIV');
      expect(c.querySelector('.se-callout-icon')).toBeTruthy();
      expect(c.querySelector('.se-callout-title')!.textContent!.trim()).toBe('My title');
      expect(c.querySelector('.se-callout-content strong')!.textContent).toBe('text');
      expect(el.querySelector('blockquote')).toBeNull();
    }
  });
  it('maps aliases and is case-insensitive (GitHub alerts)', () => {
    expect(dom('> [!FAQ]\n> x').querySelector('.se-callout')!.getAttribute('data-callout')).toBe('question');
    expect(dom('> [!WARNING]\n> x').querySelector('.se-callout')!.getAttribute('data-callout')).toBe('warning');
    expect(dom('> [!error] Boom').querySelector('.se-callout')!.getAttribute('data-callout')).toBe('danger');
  });
  it('uses the type as default title and supports inline markdown in titles', () => {
    expect(dom('> [!tip]\n> x').querySelector('.se-callout-title')!.textContent!.trim()).toBe('Tip');
    expect(dom('> [!note] A `code` title').querySelector('.se-callout-title code')!.textContent).toBe('code');
  });
  it('title-only callouts have empty content', () => {
    const c = dom('> [!info] Only a title').querySelector('.se-callout')!;
    expect(c.querySelector('.se-callout-content')!.children.length).toBe(0);
  });
  it('foldable callouts become <details>', () => {
    const closed = dom('> [!faq]- Folded\n> hidden').querySelector('.se-callout')!;
    expect(closed.tagName).toBe('DETAILS');
    expect(closed.hasAttribute('open')).toBe(false);
    expect(closed.querySelector('summary.se-callout-title .se-callout-fold')).toBeTruthy();
    const open = dom('> [!faq]+ Open\n> shown').querySelector('.se-callout')!;
    expect(open.tagName).toBe('DETAILS');
    expect(open.hasAttribute('open')).toBe(true);
  });
  it('nests callouts', () => {
    const el = dom('> [!note] Outer\n> text\n> > [!warning] Inner\n> > deep\n>\n> after');
    const outer = el.querySelector(':scope > .se-callout')!;
    const inner = outer.querySelector('.se-callout-content > .se-callout')!;
    expect(inner.getAttribute('data-callout')).toBe('warning');
    expect(inner.querySelector('.se-callout-content')!.textContent).toContain('deep');
    expect(outer.querySelector(':scope > .se-callout-content')!.lastElementChild!.textContent).toBe('after');
  });
  it('leaves ordinary blockquotes alone', () => {
    expect(dom('> just a quote').querySelector('blockquote')).toBeTruthy();
  });
});

describe('wikilinks', () => {
  it('resolved link', () => {
    const a = dom('See [[kubernetes]].').querySelector('a.se-wikilink')!;
    expect(a.textContent).toBe('kubernetes');
    expect(a.getAttribute('data-wikilink')).toBe('kubernetes');
    expect(a.getAttribute('data-path')).toBe('notes/kubernetes.md');
    expect(a.classList.contains('is-unresolved')).toBe(false);
    expect(a.getAttribute('href')).toBe('kubernetes.md');
  });
  it('unresolved link is styled differently', () => {
    const a = dom('[[Nope]]').querySelector('a.se-wikilink')!;
    expect(a.classList.contains('is-unresolved')).toBe(true);
    expect(a.hasAttribute('data-path')).toBe(false);
  });
  it('alias and heading', () => {
    const a = dom('[[README|the readme]] and [[README#Commands]]').querySelectorAll('a.se-wikilink');
    expect(a[0].textContent).toBe('the readme');
    expect(a[0].getAttribute('data-path')).toBe('README.md');
    expect(a[1].textContent).toBe('README > Commands');
    expect(a[1].getAttribute('data-wikilink')).toBe('README#Commands');
    expect(a[1].getAttribute('href')).toBe('../README.md#Commands');
  });
  it('is not parsed inside code', () => {
    const el = dom('`[[README]]`\n\n```\n[[README]]\n```');
    expect(el.querySelector('a.se-wikilink')).toBeNull();
  });
  it('escaped pipe inside tables', () => {
    const el = dom('| a |\n|---|\n| [[README\\|alias]] |');
    expect(el.querySelector('td a.se-wikilink')!.textContent).toBe('alias');
  });
});

describe('embeds', () => {
  it('note embed emits a placeholder for the controller', () => {
    const e = dom('![[kubernetes#Pods]]').querySelector('.se-embed')!;
    expect(e.getAttribute('data-embed')).toBe('kubernetes');
    expect(e.getAttribute('data-embed-frag')).toBe('Pods');
    expect(e.getAttribute('data-path')).toBe('notes/kubernetes.md');
    expect(e.querySelector('a.se-wikilink')).toBeTruthy();
  });
  it('image embed resolves through resolveUrl, with Obsidian width syntax', () => {
    const img = dom('![[pic.png|120]]', { resolveUrl: (p) => `/api/file?path=${encodeURIComponent(p)}` }).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/file?path=assets%2Fpic.png');
    expect(img.getAttribute('width')).toBe('120');
    expect(img.getAttribute('data-ws-src')).toBe('assets/pic.png');
  });
  it('markdown images resolve relative to the note', () => {
    const img = dom('![alt](../assets/pic.png)', { resolveUrl: (p) => `ws://${p}` }).querySelector('img')!;
    expect(img.getAttribute('data-ws-src')).toBe('assets/pic.png');
    expect(img.getAttribute('src')).toBe('ws://assets/pic.png');
    expect(img.getAttribute('alt')).toBe('alt');
  });
  it('remote images load only when the note may (remote: true), untouched by resolveUrl', () => {
    const img = dom('![x](https://example.com/a.png)', { resolveUrl: () => 'NOPE', remote: true }).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
  });
  it('remote images are placeholders by default (no request), keeping alt and size', () => {
    const img = dom('<img src="https://example.com/a.png" alt="chart" width="40">').querySelector('img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('se-remote-blocked')).toBe(true);
    expect(img.getAttribute('alt')).toBe('chart');
    expect(img.getAttribute('width')).toBe('40');
    expect(img.getAttribute('title')).toContain('example.com');
  });
  it('unresolved embed', () => {
    expect(dom('![[Missing note]]').querySelector('.se-embed')!.classList.contains('is-unresolved')).toBe(true);
  });
});

describe('tags vs headings', () => {
  it('# Heading is a heading, #tag is a tag', () => {
    const el = dom('# Heading\n\n#tag at line start and #nested/tag-1 inline');
    expect(el.querySelector('h1')!.textContent).toBe('Heading');
    expect([...el.querySelectorAll('.se-tag')].map((t) => t.textContent)).toEqual(['#tag', '#nested/tag-1']);
    expect(el.querySelector('.se-tag')!.getAttribute('data-tag')).toBe('tag');
  });
  it('not in code, links, URLs, words or pure numbers', () => {
    const el = dom('`#code` [#inlink](https://x.y/#frag) https://example.com/#anchor issue#12 #123 C# \n\n```\n#fenced\n```');
    expect(el.querySelector('.se-tag')).toBeNull();
  });
  it('heading gets slug id + anchor link', () => {
    const el = dom('## Hello, World!\n\n## Hello, World!');
    const hs = el.querySelectorAll('h2');
    expect(hs[0].getAttribute('data-slug')).toBe('hello-world');
    // Prefixed by the sanitizer (named props); the preview / export put the slug back (fixHeadingIds).
    expect(hs[0].id).toBe('user-content-hello-world');
    expect(hs[1].getAttribute('data-slug')).toBe('hello-world-1');
    expect(hs[0].querySelector('a.se-anchor')!.getAttribute('href')).toBe('#hello-world');
    expect(slugify('Über cool_Thing 2')).toBe('über-cool_thing-2');
  });
});

describe('inline extensions', () => {
  it('==highlight==', () => {
    const el = dom('a ==very **bold** mark== b, not == this == and a==b');
    expect(el.querySelectorAll('mark').length).toBe(1);
    expect(el.querySelector('mark strong')!.textContent).toBe('bold');
  });
  it('%%comments%% are hidden (inline and block)', () => {
    const el = dom('before %%secret%% after\n\n%%\nblock secret\n\n# hidden heading\n%%\n\nvisible');
    expect(el.textContent).not.toContain('secret');
    expect(el.querySelector('h1')).toBeNull();
    expect(el.textContent).toContain('before  after');
    expect(el.textContent).toContain('visible');
  });
  it('strikethrough, autolinks, tables with alignment', () => {
    const el = dom('~~gone~~ https://example.com\n\n| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
    expect(el.querySelector('s, del')!.textContent).toBe('gone');
    const a = el.querySelector('a[href="https://example.com"]')!;
    expect(a.classList.contains('se-external')).toBe(true);
    expect(a.getAttribute('rel')).toContain('noopener');
    const th = el.querySelectorAll('.se-table-wrap table th');
    expect(th[1].getAttribute('style')).toContain('center');
    expect(th[2].getAttribute('style')).toContain('right');
  });
  it('does not autolink file names', () => {
    expect(dom('see README.md and foo.io').querySelector('a')).toBeNull();
  });
  it('footnotes', () => {
    const el = dom('Text[^1] more[^note].\n\n[^1]: First.\n[^note]: Second.');
    expect(el.querySelectorAll('sup.footnote-ref a').length).toBe(2);
    expect(el.querySelectorAll('.footnotes li').length).toBe(2);
    expect(el.querySelector('.footnotes')!.textContent).toContain('First.');
  });
  it('block ids are hidden and exposed', () => {
    const p = dom('A paragraph ^abc-1').querySelector('p')!;
    expect(p.textContent).toBe('A paragraph');
    expect(p.getAttribute('data-block')).toBe('abc-1');
  });
});

describe('frontmatter', () => {
  it('renders a compact properties table, not an <hr> mess', () => {
    const el = dom('---\ntitle: Daily notes\ntags: [journal, daily]\naliases:\n  - One\n  - Two\ndraft: true\nurl: https://example.com/x\n---\n\n# H');
    const fm = el.querySelector('.se-frontmatter')!;
    expect(el.querySelector('hr')).toBeNull();
    const rows = [...fm.querySelectorAll('tr')].map((r) => [r.querySelector('th')!.textContent, r.querySelector('td')!.textContent]);
    expect(rows[0]).toEqual(['title', 'Daily notes']);
    expect([...fm.querySelectorAll('.se-tag')].map((t) => t.textContent)).toEqual(['#journal', '#daily']);
    expect([...fm.querySelectorAll('.se-pill')].map((t) => t.textContent)).toEqual(['One', 'Two']);
    expect(fm.querySelector('input[type=checkbox]')!.hasAttribute('checked')).toBe(true);
    expect(fm.querySelector('a')!.getAttribute('href')).toBe('https://example.com/x');
    expect(el.querySelector('h1')!.getAttribute('data-line')).toBe('10');
  });
  it('only at the very top; --- elsewhere is a rule', () => {
    const el = dom('text\n\n---\n\nmore');
    expect(el.querySelector('.se-frontmatter')).toBeNull();
    expect(el.querySelector('hr')).toBeTruthy();
  });
  it('parser handles scalars, lists and rejects non-YAML', () => {
    expect(parseFrontmatter('a: 1\nb: "q"\nc: [x, y]\nd:\n  - z')).toEqual([['a', '1'], ['b', 'q'], ['c', ['x', 'y']], ['d', ['z']]]);
    expect(parseFrontmatter('just some text')).toBeNull();
  });
  it('escapes values', () => {
    const el = dom('---\ntitle: <img src=x onerror=alert(1)>\n---\n');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('td')!.textContent).toContain('<img');
  });
});

describe('math', () => {
  it('inline and block math produce placeholders with the TeX source', () => {
    const el = dom('Inline $e^{i\\pi} + 1 = 0$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n$$a+b$$');
    const m = el.querySelectorAll('.se-math');
    expect(m.length).toBe(3);
    expect(m[0].textContent).toBe('e^{i\\pi} + 1 = 0');
    expect(m[0].classList.contains('se-math-display')).toBe(false);
    expect(m[1].tagName).toBe('DIV');
    expect(m[1].textContent).toBe('\\int_0^1 x\\,dx');
    expect(m[2].classList.contains('se-math-display')).toBe(true);
  });
  it('dollar prices are not math', () => {
    for (const s of ['It costs $5 and $10.', 'between $5 and $ 10', 'a $ b $ c', 'price: $20', 'escaped \\$x\\$']) {
      expect(dom(s).querySelector('.se-math'), s).toBeNull();
    }
    expect(dom('It costs $5 and $10.').textContent).toContain('$5 and $10.');
  });
  it('code wins over math', () => {
    const el = dom('`$this->render()` and `$x$`');
    expect(el.querySelector('.se-math')).toBeNull();
    expect(el.querySelectorAll('code').length).toBe(2);
  });
});

describe('task lists', () => {
  it('checkbox markup carries the source line', () => {
    const el = dom('# T\n\n- [ ] one\n- [x] two\n  - [ ] nested\n- plain\n\n> - [ ] quoted');
    const boxes = [...el.querySelectorAll<HTMLInputElement>('input.se-task')];
    expect(boxes.map((b) => b.getAttribute('data-line'))).toEqual(['2', '3', '4', '7']);
    expect(boxes.map((b) => b.hasAttribute('checked'))).toEqual([false, true, false, false]);
    expect(el.querySelector('ul')!.classList.contains('contains-task-list')).toBe(true);
    expect(el.querySelectorAll('li.se-task-item').length).toBe(4);
    expect(el.querySelector('li.is-checked')!.textContent).toContain('two');
    expect(el.querySelector('li')!.textContent!.trim()).toBe('one');
  });
  it('lineOffset shifts lines; sourceLines:false disables boxes', () => {
    expect(dom('- [ ] a', { lineOffset: 40 }).querySelector('input')!.getAttribute('data-line')).toBe('40');
    const off = dom('- [ ] a', { sourceLines: false });
    expect(off.querySelector('input')!.hasAttribute('disabled')).toBe(true);
    expect(off.querySelector('[data-line]')).toBeNull();
  });
});

describe('code blocks', () => {
  it('language label, copy button, shiki language id', () => {
    const el = dom('```php title="index.php"\n<?php echo 1;\n```\n\n```sh\nls\n```\n\n```unknownlang\nx\n```');
    const blocks = el.querySelectorAll('.se-code');
    expect(blocks[0].getAttribute('data-lang')).toBe('php');
    expect(blocks[0].querySelector('.se-code-lang')!.textContent).toBe('index.php · PHP');
    expect(blocks[0].querySelector('button.se-code-copy')).toBeTruthy();
    expect(blocks[0].querySelector('pre > code')!.textContent).toBe('<?php echo 1;\n');
    expect(blocks[1].getAttribute('data-lang')).toBe('shellscript');
    expect(blocks[2].getAttribute('data-lang')).toBe('');
    expect(blocks[2].querySelector('.se-code-lang')!.textContent).toBe('unknownlang');
  });
  it('mermaid and math fences get their own containers', () => {
    const el = dom('```mermaid\ngraph TD; A-->B;\n```\n\n```math\nx^2\n```');
    expect(el.querySelector('.se-mermaid code')!.textContent).toContain('graph TD');
    expect(el.querySelector('.se-math.se-math-display')!.textContent).toBe('x^2');
    expect(el.querySelector('.se-code')).toBeNull();
  });
});

describe('data-line', () => {
  it('top-level blocks carry data-line and data-end', () => {
    const el = dom('# A\n\npara one\nstill\n\n- a\n- b\n\n```js\nx\n```\n\n| a |\n|---|\n| 1 |\n\n> quote');
    const top = [...el.children].map((c) => [c.tagName, c.getAttribute('data-line'), c.getAttribute('data-end')]);
    expect(top).toEqual([
      ['H1', '0', '1'],
      ['P', '2', '4'],
      ['UL', '5', '8'],
      ['DIV', '8', '11'],
      ['DIV', '12', '15'],
      ['BLOCKQUOTE', '16', '17'],
    ]);
    expect([...el.querySelectorAll('li')].map((l) => l.getAttribute('data-line'))).toEqual(['5', '6']);
  });
});

describe('sanitization', () => {
  it('strips scripts, event handlers and javascript: URLs', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n<a href="javascript:alert(1)" onclick="x()">raw</a>\n\n<iframe src="https://evil"></iframe>\n\n<style>body{display:none}</style>\n\n<form action="/x"><input name="q"><textarea></textarea></form>',
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror|onclick/i);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('[click](javascript:alert(1))'); // markdown-it refuses to make it a link at all
    expect(html).not.toMatch(/<iframe|<style|<form|<textarea|<input/i);
  });
  it('keeps harmless raw HTML', () => {
    const el = dom('<details><summary>More</summary>\n\nHidden **md**\n\n</details>\n\n<kbd>Ctrl</kbd> <span style="color:red">red</span> <sub>2</sub>');
    expect(el.querySelector('details summary')!.textContent).toBe('More');
    expect(el.querySelector('kbd')!.textContent).toBe('Ctrl');
    expect(el.querySelector('span[style]')!.getAttribute('style')).toContain('red');
  });
  it('drops styles that could overlay the app or load resources', () => {
    const el = dom('<div style="position:fixed;inset:0">x</div><div style="background:url(https://evil/x.png)">y</div>');
    expect(el.querySelector('[style]')).toBeNull();
  });
  it('wikilink / tag text is escaped', () => {
    const html = renderMarkdown('[[<img src=x onerror=alert(1)>]] [[a|<b onclick=x>]]');
    expect(html).not.toMatch(/<img|onclick=x>/);
  });
  it('data: and file: URLs in links are removed', () => {
    const el = dom('[a](data:text/html,<script>1</script>) [b](file:///etc/passwd)');
    for (const a of el.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^(data|file):/);
  });
});

describe('performance', () => {
  // Timing budget: retried so a burst of CPU contention from the parallel suite can't fail it; a real regression fails every attempt.
  it('renders a large document quickly (pipeline only)', { retry: 2 }, () => {
    const chunk = '## Section\n\nSome *text* with `code`, a [[README]] link, #tag and $x^2$ math.\n\n- [ ] task\n- item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n';
    const src = chunk.repeat(Math.ceil(300_000 / chunk.length));
    const t0 = performance.now();
    const html = renderMarkdown(src, { files: FILES });
    const ms = performance.now() - t0;
    expect(html.length).toBeGreaterThan(src.length);
    expect(ms).toBeLessThan(5000); // happy-dom's DOMPurify pass is far slower than Chromium's; real budget is checked in E2E
  });
});
