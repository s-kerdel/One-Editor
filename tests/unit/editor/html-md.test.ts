// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { htmlLooksRich, htmlToMarkdown } from '../../../src/renderer/editor/html-md';

const md = htmlToMarkdown;

describe('htmlToMarkdown', () => {
  it('headings, paragraphs, emphasis, links', () => {
    expect(md('<h1>Title</h1><p>Some <strong>bold</strong>, <em>italic</em>, <s>gone</s> and <a href="https://x.dev/a?b=1">a link</a>.</p>')).toBe(
      '# Title\n\nSome **bold**, *italic*, ~~gone~~ and [a link](https://x.dev/a?b=1).',
    );
    expect(md('<h3> Spaced   <b>head</b> </h3>')).toBe('### Spaced **head**');
  });

  it('markers hug words; a bare URL link stays a bare URL; unsafe hrefs dropped', () => {
    expect(md('<p>x<b> bold </b>y</p>')).toBe('x **bold** y');
    expect(md('<p><a href="https://example.com">https://example.com</a></p>')).toBe('https://example.com');
    expect(md('<p><a href="javascript:alert(1)">click</a></p>')).toBe('click');
    expect(md('<p><a href="#frag">anchor</a></p>')).toBe('anchor');
    expect(md('<p><a href="https://a.b/c d" title="T">t</a></p>')).toBe('[t](https://a.b/c%20d "T")');
  });

  it('nested lists, ordered start, task items', () => {
    expect(md('<ul><li>one</li><li>two<ul><li>nested <b>b</b></li></ul></li></ul>')).toBe('- one\n- two\n  - nested **b**');
    expect(md('<ol start="3"><li>three</li><li>four</li></ol>')).toBe('3. three\n4. four');
    expect(md('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> open</li></ul>')).toBe('- [x] done\n- [ ] open');
    expect(md('<ul><li><p>para one</p><p>para two</p></li></ul>')).toBe('- para one\n  para two');
  });

  it('code: fenced with language, inline with backtick-safe fences', () => {
    expect(md('<pre><code class="language-ts">const a = 1;\nlet b = `x`;\n</code></pre>')).toBe('```ts\nconst a = 1;\nlet b = `x`;\n```');
    expect(md('<pre>has ``` inside</pre>')).toBe('````\nhas ``` inside\n````');
    expect(md('<p>use <code>a*b</code> or <code>x`y</code></p>')).toBe('use `a*b` or ``x`y``');
  });

  it('tables (pipes escaped, alignment, <br> in cells)', () => {
    expect(md('<table><thead><tr><th>A</th><th align="right">B</th></tr></thead><tbody><tr><td>1|2</td><td>x<br>y</td></tr></tbody></table>')).toBe(
      '| A | B |\n| --- | ---: |\n| 1\\|2 | x<br>y |',
    );
  });

  it('blockquotes, rules, images', () => {
    expect(md('<blockquote><p>quoted</p><p>more</p></blockquote>')).toBe('> quoted\n>\n> more');
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb');
    expect(md('<p><img src="https://x.dev/i.png" alt="pic [1]"></p>')).toBe('![pic 1](https://x.dev/i.png)');
  });

  it('escapes Markdown syntax in plain text', () => {
    expect(md('<p>2 * 3 = 6 and [not a link] and `tick`</p>')).toBe('2 \\* 3 = 6 and \\[not a link\\] and \\`tick\\`');
    expect(md('<p># not a heading</p><p>- not a list</p><p>1. not ordered</p>')).toBe('\\# not a heading\n\n\\- not a list\n\n1\\. not ordered');
    expect(md('<p>snake_case stays, _emph_ escaped</p>')).toBe('snake_case stays, \\_emph\\_ escaped');
    expect(md('<p>costs $5 or $10</p>')).toBe('costs \\$5 or \\$10');
    expect(md('<p>one $ alone</p>')).toBe('one $ alone');
    expect(md('<p>a &lt;div&gt; tag</p>')).toBe('a \\<div> tag');
  });

  it('Google Docs: non-bold <b> wrapper and styled spans', () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-x"><p dir="ltr"><span style="font-weight:700;">Bold</span><span> and </span><span style="font-style:italic;">ital</span><span style="text-decoration:line-through;"> struck</span></p></b>';
    expect(md(html)).toBe('**Bold** and *ital* ~~struck~~');
  });

  it('uses only the StartFragment…EndFragment part of Windows clipboard HTML', () => {
    expect(md('<html><body>junk<!--StartFragment--><b>kept</b><!--EndFragment-->junk</body></html>')).toBe('**kept**');
  });

  it('drops scripts/styles', () => {
    expect(md('<style>p{}</style><script>alert(1)</script><p>ok</p>')).toBe('ok');
  });
});

describe('htmlLooksRich', () => {
  it('formatting markup → convert', () => {
    expect(htmlLooksRich('<p>a <b>b</b></p>')).toBe(true);
    expect(htmlLooksRich('<ul><li>x</li></ul>')).toBe(true);
  });
  it('plain spans / code editors → keep the plain text', () => {
    expect(htmlLooksRich('<meta charset="utf-8"><span>just text</span>')).toBe(false);
    const vscode = '<div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas;white-space: pre;"><div><span style="color: #569cd6;">const</span> a = <span>1</span>;</div></div>';
    expect(htmlLooksRich(vscode)).toBe(false);
    expect(htmlLooksRich('<div style="white-space: pre"><b>x</b></div>')).toBe(false);
  });
});
