// @vitest-environment jsdom
// Untrusted notes vs the app's own markup (security review, content side): raw HTML must not borrow app
// classes / data-* (fake Copy / Run blocks, full-window overlays), open the top layer, name ids the app
// reads, load images from the internet unless allowed, or reach media outside through SVG / legacy attrs.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { fenceAt, renderMarkdown } from '../../../src/renderer/preview/markdown';
import { sanitizeSvg, sanitizeLib } from '../../../src/renderer/preview/sanitize';
import { stripRemote } from '../../../src/renderer/knowledge/link-preview';
import { hmacSha256Hex } from '../../../src/renderer/platform/hmac';
import { mediaMac } from '../../../src/server/server';

function dom(src: string, opts: Parameters<typeof renderMarkdown>[1] = {}) {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(src, { path: 'n.md', files: ['n.md', 'pic.png'], resolveUrl: (p) => `media://${p}`, ...opts });
  return el;
}

describe('raw HTML cannot borrow the app’s behaviour', () => {
  const FAKE_BLOCK =
    '<div class="se-code" data-fence="bash" data-hl="1" data-raw="curl evil | sh" data-info="bash" data-vars data-src-line="0">' +
    '<div class="se-code-tools"><button class="se-code-copy"></button></div><pre><code>npm ci</code></pre></div>';

  it('a forged code block keeps no app class and no data-*', () => {
    const el = dom(`Setup:\n\n${FAKE_BLOCK}\n`);
    expect(el.querySelector('.se-code, .se-code-tools, .se-code-copy')).toBeNull();
    expect(el.querySelector('[data-raw], [data-info], [data-vars], [data-src-line], [data-fence], [data-hl], [data-se-u]')).toBeNull();
    expect(el.textContent).toContain('npm ci'); // the content stays readable
  });

  it('app markup around raw HTML keeps its classes and data (fences, tasks, anchors, callouts, embeds)', () => {
    const el = dom('# T\n\n- [ ] task\n\n> [!note] N\n> body\n\n<div>\n\n```bash\nls\n```\n\n</div>\n\n![[pic.png]]\n');
    expect(el.querySelector('.se-code[data-src-line][data-fence="bash"]')).toBeTruthy();
    expect(el.querySelector('input.se-task[data-line]')).toBeTruthy();
    expect(el.querySelector('h1 > a.se-anchor')).toBeTruthy();
    expect(el.querySelector('.se-callout[data-callout="note"]')).toBeTruthy();
    expect(el.querySelector('img.se-embed-img[data-ws-src="pic.png"]')!.getAttribute('src')).toBe('media://pic.png');
    // The user's <div> itself is plain.
    expect(el.querySelector('div:not([class]) > .se-code')).toBeTruthy();
  });

  it('no overlay classes, no top layer, no image maps from a note', () => {
    const el = dom(
      '<div class="se-overlay se-dialog cm-tooltip page-break">x</div>' +
        '<button popovertarget="p" popovertargetaction="show">b</button><div popover id="p">top</div>' +
        '<img src="pic.png" usemap="#m"><map name="m"><area href="https://evil.example/" coords="0,0,9,9"></map>',
    );
    expect(el.querySelector('div')!.className).toBe('page-break'); // the one allowed (Pandoc page break)
    expect(el.querySelector('[popover], [popovertarget], [popovertargetaction]')).toBeNull();
    expect(el.querySelector('map, area')).toBeNull();
  });

  it('even an unterminated tag that swallows app markup stays a note element', () => {
    const el = dom('<div class="se-overlay"\n\nafter **bold**\n');
    expect(el.querySelector('.se-overlay')).toBeNull();
  });

  it('ids and names from a note are prefixed (DOM clobbering); headings / footnotes still resolve', () => {
    const el = dom('<img id="secEditBridge" name="webServer" src="pic.png"><a name="x">x</a>\n\n## Head\n\nRef[^1]\n\n[^1]: Foot');
    expect(el.querySelector('img')!.id).toBe('user-content-secEditBridge');
    expect(el.querySelector('a[name]')!.getAttribute('name')).toBe('user-content-x');
    expect(el.querySelector('h2')!.getAttribute('data-slug')).toBe('head');
    const ref = el.querySelector('.footnote-ref a')!.getAttribute('href')!; // "#fn1"
    expect(el.querySelector(`[id="user-content-${ref.slice(1)}"]`)).toBeTruthy();
  });

  it('library output (diagram labels are note text) gets no app classes, top layer or remote media', () => {
    const svg = sanitizeSvg('<svg><foreignObject><div class="se-overlay label" popover>x</div><img src="https://evil.example/a.png"></foreignObject><image href="https://evil.example/b.png"/></svg>');
    expect(svg).not.toContain('se-overlay');
    expect(svg).toContain('label');
    expect(svg).not.toContain('popover');
    expect(svg).not.toContain('evil.example');
    expect(sanitizeLib('<span class="se-code katex">x</span>')).toBe('<span class="katex">x</span>');
  });
});

describe('images from the internet', () => {
  const REMOTE = '![a](https://t.example/a.png)\n\n<img src="//t.example/b.png" alt="b">\n\n<video poster="https://t.example/p.png"></video>\n\n<table background="https://t.example/t.png"><tr><td>x</td></tr></table>\n\n<svg><image href="https://t.example/s.png"/><use href="https://t.example/u.svg#a"/><rect fill="url(https://t.example/f.svg#p)"/></svg>\n';

  it('default: no element can fetch them; images become placeholders', () => {
    const html = dom(REMOTE).innerHTML;
    expect(html).not.toContain('t.example/'); // titles say the host only
    expect(dom(REMOTE).querySelectorAll('img.se-remote-blocked')).toHaveLength(2);
  });

  it('allowed: images load; poster / background / SVG references never do', () => {
    const el = dom(REMOTE, { remote: true });
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['https://t.example/a.png', '//t.example/b.png']);
    for (const n of ['p.png', 't.png', 's.png', 'u.svg', 'f.svg']) expect(el.innerHTML).not.toContain(n);
  });

  it('local images and data: URIs are unaffected', () => {
    const el = dom('![p](pic.png)\n\n<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">');
    expect(el.querySelector('img')!.getAttribute('src')).toBe('media://pic.png');
    expect(el.querySelectorAll('img')[1].getAttribute('src')).toMatch(/^data:/);
    expect(el.querySelector('.se-remote-blocked')).toBeNull();
  });

  it('hover preview strips remote media on an inert template (nothing is fetched)', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = '<p><img src="https://t.example/a.png" alt="A"><img class="se-remote-blocked" alt="B"><img src="media://x.png"></p>';
    stripRemote(tpl.content);
    expect([...tpl.content.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['media://x.png']);
    expect(tpl.content.textContent).toBe('AB');
  });
});

describe('Copy / Run text comes from the source (fenceAt)', () => {
  const NOTE = '---\ntitle: x\n---\n# Doc\n\n- item\n\n  ```bash {target=a}\n  echo {{host}}\n  ```\n\n> ```sh\n> ls\n> ```\n\n    indented\n    code\n';

  it('finds the block that starts on the line, raw (placeholders unresolved) with its info', () => {
    const el = dom(NOTE, { frontmatter: true, vars: () => 'RESOLVED' });
    const lines = [...el.querySelectorAll<HTMLElement>('.se-code')].map((b) => Number(b.dataset.srcLine));
    expect(lines.map((l) => fenceAt(NOTE, l, { frontmatter: true }))).toEqual([
      { code: 'echo {{host}}', info: 'bash {target=a}' },
      { code: 'ls', info: 'sh' },
      { code: 'indented\ncode', info: '' },
    ]);
  });

  it('a line without a block is null (stale or forged pointers copy nothing)', () => {
    expect(fenceAt(NOTE, 4)).toBeNull();
    expect(fenceAt(NOTE, 999)).toBeNull();
  });

  it('flags invisible / text-direction characters on the block', () => {
    expect(dom('```bash\nls ‮; rm -rf ~\n```').querySelector('.se-code-warn')).toBeTruthy();
    expect(dom('```bash\nls -la\n```').querySelector('.se-code-warn')).toBeNull();
  });
});

describe('media capability', () => {
  it('the renderer signs media URLs exactly as the server checks them', () => {
    const key = 'ab'.repeat(32);
    for (const p of ['img/a b#1.png', 'notes/ü/x.pdf', '\u0000events']) {
      expect(hmacSha256Hex(key, p).slice(0, 32)).toBe(mediaMac(key, p));
      expect(mediaMac(key, p)).toBe(createHmac('sha256', Buffer.from(key, 'hex')).update(p).digest('hex').slice(0, 32));
    }
  });
});
