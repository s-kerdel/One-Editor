// @vitest-environment jsdom
// Hostile markdown → sanitized HTML. Nothing may survive that runs script, navigates, or overlays the app.
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../../src/renderer/preview/markdown';
import { sanitizeHtml, sanitizeSvg, sanitizeLib } from '../../../src/renderer/preview/sanitize';

const BAD_TAGS = /^(script|iframe|object|embed|meta|base|form|style|link|frame|frameset|applet|portal|template|animate|set)$/i;
const BAD_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

/** Every way the HTML could run script or navigate, found by walking the parsed DOM (not text). */
function problems(html: string): string[] {
  const box = document.createElement('div');
  box.innerHTML = html;
  const out: string[] = [];
  for (const el of box.querySelectorAll('*')) {
    if (BAD_TAGS.test(el.localName)) out.push(`<${el.localName}>`);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name) || /^(srcdoc|formaction)$/i.test(a.name)) out.push(`${el.localName}[${a.name}]`);
      if (/(^|:)(href|src|action|data|poster|xlink:href)$/i.test(a.name) && BAD_URL.test(a.value.replace(/[\u0000-\u0020]/g, ''))) out.push(`${el.localName}[${a.name}=${a.value}]`);
    }
  }
  return out;
}

const PAYLOADS = [
  '<script>window.__pwned=1</script>',
  '<img src=x onerror="window.__pwned=1">',
  '<svg><script>window.__pwned=1</script></svg>',
  '<svg onload="window.__pwned=1"></svg>',
  '<svg><foreignObject><img src=x onerror="window.__pwned=1"></foreignObject></svg>',
  '<svg><a xlink:href="javascript:window.__pwned=1"><text y="20">x</text></a></svg>',
  '<svg><animate attributeName="href" to="javascript:window.__pwned=1"/></svg>',
  '<svg><use href="data:image/svg+xml,&lt;svg id=x xmlns=http://www.w3.org/2000/svg&gt;&lt;script&gt;window.__pwned=1&lt;/script&gt;&lt;/svg&gt;#x"/></svg>',
  '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
  '<meta http-equiv="refresh" content="0;url=javascript:window.__pwned=1">',
  '<base href="javascript:window.__pwned=1//">',
  '<form action="javascript:window.__pwned=1"><button>go</button></form>',
  '<button formaction="javascript:window.__pwned=1">x</button>',
  '<a href="javascript:window.__pwned=1">a</a>',
  '<a href="&#106;avascript:window.__pwned=1">b</a>',
  '<a href="java\tscript:window.__pwned=1">c</a>',
  '<a href="vbscript:msgbox(1)">d</a>',
  '<a href="data:text/html,<script>window.__pwned=1</script>">e</a>',
  '[md](javascript:window.__pwned=1)',
  '[md2](<javascript:window.__pwned=1>)',
  '![img](javascript:window.__pwned=1)',
  '<object data="evil.html"></object><embed src="evil.html">',
  '<link rel="stylesheet" href="https://evil/x.css">',
  '<style>@import url(https://evil/x.css); body{display:none}</style>',
  '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned=1">',
  '<noscript><p title="</noscript><img src=x onerror=window.__pwned=1>">',
  '<details open ontoggle="window.__pwned=1"><summary>x</summary></details>',
  '<video><source onerror="window.__pwned=1"></video>',
  '<input type="image" src=x onerror="window.__pwned=1">',
  '<div data-x="1" onclick="window.__pwned=1">click</div>',
  '<portal src="https://evil"></portal><frameset><frame src="x"></frameset>',
  '[[x" onmouseover="window.__pwned=1]]',
  '![[x" onerror="window.__pwned=1]]',
  '$\\href{javascript:window.__pwned=1}{x}$',
];

describe('hostile markdown', () => {
  it.each(PAYLOADS)('neutralises %s', (src) => {
    const html = renderMarkdown(src, { path: 'notes/evil.md', files: ['notes/evil.md', 'evil.html'], resolveUrl: (p) => `app://sec-edit/__ws/${p}` });
    expect(problems(html)).toEqual([]);
  });

  it('keeps harmless inline styles', () => {
    const html = sanitizeHtml('<span style="color:red;text-align:center">x</span>');
    expect(html).toContain('color:red');
  });

  it.each([
    ['CSS escape', '<div style="p\\osition:fixed;inset:0">x</div>'],
    ['hex escape', '<div style="p\\6f sition:fixed;inset:0">x</div>'],
    ['comment', '<div style="position/**/:fixed;inset:0">x</div>'],
    ['url escape', '<div style="background:\\75rl(https://evil/x.png)">x</div>'],
    ['image-set', `<div style="background-image:image-set('https://evil/x.png' 1x)">x</div>`],
    ['z-index escape', '<div style="z-ind\\ex:99999">x</div>'],
  ])('drops overlay/resource styles hidden with a %s', (_name, src) => {
    const html = sanitizeHtml(src);
    expect(html).not.toMatch(/style=/);
  });

  it('workspace media paths from raw HTML stay workspace-relative', () => {
    const html = renderMarkdown('<img data-ws-src="../../../etc/passwd"><img src="../../../../etc/shadow">', { path: 'notes/a.md', files: [], resolveUrl: (p) => `ws:${p}` });
    expect(html).not.toContain('..');
  });
});

describe('library output sanitizers', () => {
  it('mermaid SVG keeps its <style> but no script', () => {
    const out = sanitizeSvg('<svg id="m"><style>#m{fill:red}</style><script>window.__pwned=1</script><foreignObject><div onclick="x()">a</div></foreignObject></svg>');
    expect(out).toContain('<style>');
    expect(out).not.toMatch(/<script|onclick/);
  });

  it('KaTeX/Shiki sanitizer strips handlers', () => {
    expect(sanitizeLib('<span class="katex" onmouseover="x()">a</span><a href="javascript:x()">b</a>')).not.toMatch(/onmouseover|javascript:/);
  });
});
