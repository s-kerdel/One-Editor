// @vitest-environment jsdom
// Security audit 2026-11-27, renderer side: raw-HTML inline styles are an allowlist (L21), exported media
// never keep the note's own src spelling (L22), and mermaid never loads anything the note's remote-media
// policy does not allow, nor carries {{variable}} values (M5).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from '../../../src/renderer/preview/markdown';
import { allowedStyle, isRemoteUrl, mermaidFetches, resolveLocalPath, sanitizeSvg } from '../../../src/renderer/preview/sanitize';

const FILES = ['notes/n.md', 'notes/img/a.png', 'pic.png'];
function dom(src: string, opts: Parameters<typeof renderMarkdown>[1] = {}) {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(src, { path: 'notes/n.md', files: FILES, ...opts });
  return el;
}

describe('raw-HTML inline styles: an allowlist (L21)', () => {
  it('keeps colours, type, sizes, spacing, borders and simple layout', () => {
    expect(allowedStyle('color: red; font-weight: bold; text-align: center', 'SPAN')).toBe('color: red; font-weight: bold; text-align: center');
    expect(allowedStyle('width: 300px; height: 200px; border-radius: 4px', 'IMG')).toBe('width: 300px; height: 200px; border-radius: 4px');
    expect(allowedStyle('display:flex;gap:1em;margin: 0 auto !important', 'DIV')).toBe('display:flex; gap:1em; margin: 0 auto !important');
  });

  it('drops whatever can move, hide or cover a code block, and custom properties', () => {
    for (const bad of [
      '--code-bg: red',
      '--text: transparent',
      '-webkit-text-fill-color: transparent',
      'transform: translateY(-40px)',
      'opacity: 0',
      'filter: blur(9px)',
      'margin-top: -3em',
      'margin: 0 0 -1px',
      'margin-top: calc(0px - 9em)',
      'mix-blend-mode: difference',
      'visibility: hidden',
      'letter-spacing: -1em',
      'text-transform: uppercase',
      'direction: rtl',
      'clip-path: inset(50%)',
      'vertical-align: 300px',
      'display: contents',
      'line-height: 0',
    ])
      expect(allowedStyle(bad, 'DIV'), bad).toBe('');
    // height on a wrapper would let the next block overlap the code inside it; on an image it is its own size
    expect(allowedStyle('height: 0', 'DIV')).toBe('');
    expect(allowedStyle('color: red; opacity: 0; --x: 1', 'SPAN')).toBe('color: red');
    expect(allowedStyle('position: fixed', 'DIV')).toBe('');
  });

  it('in a note: a wrapper around a code block keeps only allowed declarations', () => {
    const el = dom('<div style="color: green; --code-bg: red; transform: scale(0); margin-top: -40px">\n\n```bash\nrm -rf ~\n```\n\n</div>\n');
    const wrap = el.querySelector('div[style]') as HTMLElement;
    expect(wrap.getAttribute('style')).toBe('color: green');
    expect(el.querySelector('.se-code')).toBeTruthy();
    // markdown-it's own table alignment survives
    expect(dom('| a |\n|--:|\n| 1 |').querySelector('td')!.getAttribute('style')).toBe('text-align:right');
  });
});

describe('media URLs: never the note’s own spelling (L22)', () => {
  it('leading controls, tabs inside, backslash UNC and /\\ are not local; remote-looking ones are remote', () => {
    for (const u of ['\u0001https://t.example/x.png', ' \thttps://t.example/x.png', 'ht\ttps://t.example/x.png', '\\\\t.example\\share\\x.png', '/\\t.example/x.png', '\u0000//t.example/x']) {
      expect(resolveLocalPath(u, 'notes/n.md', FILES), JSON.stringify(u)).toBeNull();
      expect(isRemoteUrl(u), JSON.stringify(u)).toBe(true);
    }
    expect(resolveLocalPath('img\\a.png', 'notes/n.md', FILES)).toBe('notes/img/a.png'); // a backslash path inside stays local
    expect(isRemoteUrl('data:image/png;base64,AA')).toBe(false);
  });

  it('blocked unless allowed: no element keeps a remote src behind a control character or UNC', () => {
    const el = dom('<img src="\u0001https://t.example/a.png"><img src="\\\\t.example\\s\\b.png"><img src="/\\t.example/c.png">');
    expect(el.querySelector('[src]')).toBeNull(); // the title names the host only
    expect(el.querySelectorAll('img.se-remote-blocked')).toHaveLength(3);
  });

  it('export (no resolveUrl): local media get a path relative to the note, built from the workspace path', () => {
    const el = dom('![a](./img/../img/a.png)\n\n<img src="img\\a.png"><img src="/pic.png"><img src="%5C%5Chost%5Cs.png">', { resolveUrl: undefined });
    const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(['img/a.png', 'img/a.png', '../pic.png', 'host/s.png']);
    for (const s of srcs) expect(s).not.toMatch(/\\|^\/\/|%5C/i);
    expect(dom('![x](a%23b.png)', { resolveUrl: undefined }).querySelector('img')!.getAttribute('src')).toBe('a%23b.png');
  });
});

describe('mermaid: nothing loads the policy does not allow (M5)', () => {
  it('mermaidFetches: images, img: shapes, url() / image-set() / @import, escaped and entity forms', () => {
    for (const src of [
      'flowchart LR\n  A["<img src=\'https://t.example/a.png\'>"]',
      'flowchart LR\n  A["< IMG src=//t.example/a.png>"]',
      'flowchart LR\n  A@{ img: "https://t.example/a.png", label: "x" }',
      'flowchart LR\n  A\n  style A fill:url(https://t.example/f.svg#p)',
      'flowchart LR\n  A:::c\n  classDef c background:image-set("https://t.example/a.png" 1x)',
      'flowchart LR\n  A\n  style A background:\\75rl(https://t.example/a.png)',
      'flowchart LR\n  A\n  style A background:u\\rl(//t.example/a.png)',
      'flowchart LR\n  A["<span style=\'background:url&lpar;https://t.example/a&rpar;\'>x</span>"]',
      '%%{init: {"themeCSS": "@import \'https://t.example/x.css\';"}}%%\nflowchart LR\n  A',
      'flowchart LR\n  A["<table background=https://t.example/t.png>"]',
    ])
      expect(mermaidFetches(src), src).toBe(true);
    for (const src of ['flowchart LR\n  A["see https://example.com"] --> B\n  click A href "https://example.com"', 'flowchart LR\n  A\n  style A fill:#f9f,stroke:url(#grad)', 'sequenceDiagram\n  A->>B: C:\\apps'])
      expect(mermaidFetches(src), src).toBe(false);
  });

  it('a fetching diagram: blocked media without the policy (the "Load" bar), data-remote with it', () => {
    const src = '```mermaid\nflowchart LR\n  A["<img src=\'https://t.example/a.png\'>"]\n```\n';
    const blocked = dom(src).querySelector('.se-mermaid')!;
    expect(blocked.classList.contains('se-remote-blocked')).toBe(true);
    expect(blocked.hasAttribute('data-remote')).toBe(false);
    const allowed = dom(src, { remote: true }).querySelector('.se-mermaid')!;
    expect(allowed.classList.contains('se-remote-blocked')).toBe(false);
    expect(allowed.hasAttribute('data-remote')).toBe(true);
    expect(dom('```mermaid\nflowchart LR\n  A --> B\n```\n').querySelector('.se-mermaid.se-remote-blocked')).toBeNull();
  });

  it('{{variables}} are never substituted inside a mermaid fence', () => {
    const vars = (t: string) => t.replace(/\{\{host\}\}/g, 'db.internal');
    const el = dom('```mermaid\nflowchart LR\n  A["<img src=\'https://t.example/?h={{host}}\'>"]\n```\n\n```bash\nssh {{host}}\n```\n', { vars, remote: true });
    expect(el.querySelector('.se-mermaid')!.textContent).toContain('{{host}}');
    expect(el.querySelector('.se-mermaid')!.hasAttribute('data-vars')).toBe(false);
    expect(el.querySelector('.se-code')!.textContent).toContain('ssh db.internal');
  });

  it('library output: <style> and style attributes never fetch; remote images only when allowed', () => {
    const svg =
      '<svg><style>#m .c{background:url(https://t.example/a.png)} @import "https://t.example/x.css"; .d{fill:url(#ok)} .e{background:\\75rl(//t.example/b.png)} .f{background:image-set("https://t.example/c.png" 1x)}</style>' +
      '<g style="fill:url(https://t.example/f.svg#p)"><rect style="fill:#f9f"/></g><foreignObject><img src="https://t.example/i.png"></foreignObject><image href="https://t.example/s.png"/></svg>';
    const out = sanitizeSvg(svg);
    expect(out).not.toMatch(/url\(\s*['"]?\s*(https?:|\/\/)/);
    expect(out).not.toMatch(/@import|image-set\(/);
    expect(out).toContain('url(#ok)');
    expect(out).toContain('fill:#f9f');
    expect(out).not.toContain('i.png');
    expect(out).not.toContain('s.png');
    const allowed = sanitizeSvg(svg, { remote: true });
    expect(allowed).toContain('src="https://t.example/i.png"');
    expect(allowed).toContain('href="https://t.example/s.png"');
    expect(allowed).not.toMatch(/url\(\s*['"]?\s*(https?:|\/\/)/); // CSS still never fetches
  });
});

describe('the page itself (audit Info)', () => {
  it('remote images a note may load send no Referer; link hosts are not looked up ahead', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/index.html'), 'utf8');
    const head = html.slice(0, html.indexOf('<script'));
    expect(head).toContain('<meta name="referrer" content="no-referrer" />');
    expect(head).toContain('<meta http-equiv="x-dns-prefetch-control" content="off" />');
  });
});

// The live render: mermaid itself is mocked (no layout in jsdom) to see what it is asked to draw and with which config.
const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async (_id: string, _src: string) => ({ svg: '<svg><g><text>ok</text></g></svg>' })) }));
vi.mock('mermaid', () => ({ default: mermaidMock }));

describe('mermaid render: secure config, never drawn when it would fetch (M5)', () => {
  beforeEach(() => {
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockClear();
  });

  async function draw(markdown: string, remote: boolean) {
    const { enhanceAll } = await import('../../../src/renderer/preview/enhance');
    const el = dom(markdown, { remote });
    await enhanceAll(el, { dark: false });
    return el;
  }

  it('a fetching diagram without the policy is not handed to mermaid at all; with it, it is', async () => {
    const md = '```mermaid\nflowchart LR\n  A@{ img: "https://t.example/a.png" }\n```\n';
    const el = await draw(md, false);
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(el.querySelector('.se-mermaid-error')!.textContent).toMatch(/not drawn/);
    await draw(md, true);
    expect(mermaidMock.render).toHaveBeenCalledOnce();
  });

  it('note config cannot set CSS, theme variables or the label sanitizer; labels without the policy fetch nothing', async () => {
    await draw('```mermaid\nflowchart LR\n  A --> B\n```\n', false);
    const cfg = mermaidMock.initialize.mock.calls.at(-1)![0];
    expect(cfg.securityLevel).toBe('strict');
    for (const k of ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'themeCSS', 'fontFamily', 'altFontFamily', 'themeVariables', 'dompurifyConfig']) expect(cfg.secure).toContain(k);
    expect(cfg.dompurifyConfig.FORBID_TAGS).toEqual(expect.arrayContaining(['style', 'img', 'image', 'video', 'source']));
    expect(mermaidMock.render).toHaveBeenCalledOnce();
  });
});
