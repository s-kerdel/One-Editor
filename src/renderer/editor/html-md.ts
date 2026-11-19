// Clipboard HTML → Markdown (headings, emphasis, links, images, lists incl. tasks, code, tables, quotes).
// Walks a DOMParser document (never inserted into the page, scripts never run). Also understands the
// inline-style markup Google Docs / Word produce (bold/italic spans, the non-bold <b> wrapper).

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD', 'CENTER', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA']);
const RICH = /<(h[1-6]|strong|b|em|i|u|s|del|strike|mark|a|ul|ol|li|table|pre|code|blockquote|img|hr)\b/i;

interface Ctx {
  /** Inside <pre>: keep whitespace verbatim. */
  pre: boolean;
  /** Inside a table cell: no block breaks, pipes escaped. */
  cell: boolean;
}

/** Whether clipboard HTML carries formatting worth converting (vs. a styled plain-text copy). */
export function htmlLooksRich(html: string): boolean {
  if (!RICH.test(html)) return false;
  // Code editors (VS Code, IDEs) copy coloured <span>s inside a white-space:pre container: that's code, not prose.
  if (/white-space:\s*pre/i.test(html) && !/<(h[1-6]|ul|ol|table|blockquote|a)\b/i.test(html)) return false;
  return true;
}

function escapeText(s: string, ctx: Ctx): string {
  let out = s.replace(/([\\`*[\]])/g, '\\$1').replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_'));
  out = out.replace(/<(?=[A-Za-z/!])/g, '\\<');
  // Two dollars on a line would be read as $math$.
  if ((out.match(/\$/g) ?? []).length >= 2) out = out.replace(/\$/g, '\\$');
  if (ctx.cell) out = out.replace(/\|/g, '\\|');
  return out;
}

/** Escapes characters that would turn a line into a heading / list / quote. */
function escapeLineStarts(md: string): string {
  return md.replace(/^(\s*)([#>+-])(?=\s)/gm, '$1\\$2').replace(/^(\s*)(\d+)([.)])(?=\s)/gm, '$1$2\\$3');
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  return (el as HTMLElement).style ?? null;
}

function isBoldStyle(el: Element): boolean {
  const w = styleOf(el)?.fontWeight;
  return !!w && (w === 'bold' || w === 'bolder' || Number(w) >= 600);
}
function isNormalWeight(el: Element): boolean {
  const w = styleOf(el)?.fontWeight;
  return w === 'normal' || w === '400' || w === 'lighter';
}

function fence(code: string): string {
  let n = 3;
  for (const m of code.matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1);
  return '`'.repeat(n);
}

function inlineCode(text: string): string {
  let n = 1;
  for (const m of text.matchAll(/`+/g)) n = Math.max(n, m[0].length + 1);
  const t = '`'.repeat(n);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${t}${pad}${text}${pad}${t}`;
}

function wrap(inner: string, mark: string): string {
  // Markers must hug the text: "**word** " not "** word **".
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function langOf(el: Element | null): string {
  if (!el) return '';
  const cls = `${el.getAttribute('class') ?? ''} ${el.querySelector('code')?.getAttribute('class') ?? ''}`;
  const m = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/.exec(cls) ?? /(?:^|\s)brush:\s*([\w+#-]+)/.exec(cls);
  return m ? m[1].toLowerCase() : el.getAttribute('data-lang') ?? el.getAttribute('data-language') ?? '';
}

function safeHref(href: string | null): string | null {
  if (!href) return null;
  const h = href.trim();
  if (/^(javascript|vbscript|data):/i.test(h)) return null;
  return h.replace(/ /g, '%20').replace(/\)/g, '%29');
}

function inline(node: Node, ctx: Ctx): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) out += inlineNode(child, ctx);
  return out;
}

function inlineNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) {
    const t = node.nodeValue ?? '';
    return ctx.pre ? t : escapeText(t.replace(/[ \t\r\n\f]+/g, ' '), ctx);
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (SKIP.has(tag)) return '';
  switch (tag) {
    case 'BR':
      return ctx.cell ? '<br>' : '\n';
    case 'STRONG':
    case 'B':
      return isNormalWeight(el) ? inline(el, ctx) : wrap(inline(el, ctx), '**');
    case 'EM':
    case 'I':
    case 'CITE':
    case 'DFN':
      return wrap(inline(el, ctx), '*');
    case 'S':
    case 'DEL':
    case 'STRIKE':
      return wrap(inline(el, ctx), '~~');
    case 'MARK':
      return wrap(inline(el, ctx), '==');
    case 'CODE':
    case 'KBD':
    case 'SAMP':
    case 'TT': {
      if (ctx.pre) return el.textContent ?? '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ');
      return text ? inlineCode(text) : '';
    }
    case 'A': {
      const href = safeHref(el.getAttribute('href'));
      const text = inline(el, ctx).trim();
      if (!href || href.startsWith('#')) return text;
      if (!text) return '';
      const raw = (el.textContent ?? '').trim();
      if (raw === href || raw === href.replace(/^mailto:/, '')) return raw; // bare URL stays a bare URL
      const title = el.getAttribute('title');
      return `[${text}](${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    }
    case 'IMG': {
      const src = safeHref(el.getAttribute('src'));
      if (!src) return '';
      const alt = (el.getAttribute('alt') ?? '').replace(/[[\]]/g, '');
      return `![${alt}](${src})`;
    }
    case 'INPUT':
      return '';
    case 'SUP':
    case 'SUB':
    case 'U':
    case 'SMALL':
    case 'BIG':
    case 'FONT':
    case 'ABBR':
    case 'Q':
    case 'TIME':
    case 'LABEL':
    case 'SPAN': {
      let inner = inline(el, ctx);
      if (tag === 'SPAN' || tag === 'FONT') {
        const st = styleOf(el);
        if (st?.fontStyle === 'italic') inner = wrap(inner, '*');
        if (isBoldStyle(el)) inner = wrap(inner, '**');
        if (/line-through/.test(st?.textDecoration ?? '') || /line-through/.test(st?.textDecorationLine ?? '')) inner = wrap(inner, '~~');
      }
      return inner;
    }
    default:
      // Block element inside inline context (e.g. <div> in a table cell): flatten.
      return BLOCK.has(tag) || /^H[1-6]$/.test(tag) || tag === 'LI' || tag === 'P' ? ` ${inline(el, ctx)} ` : inline(el, ctx);
  }
}

function cleanInline(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function listItems(list: Element): Element[] {
  return Array.from(list.children).filter((c) => c.tagName.toUpperCase() === 'LI');
}

function renderList(list: Element, depth: number): string {
  const ordered = list.tagName.toUpperCase() === 'OL';
  let n = Number(list.getAttribute('start') ?? '1') || 1;
  const lines: string[] = [];
  for (const li of listItems(list)) {
    const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox], :scope > label > input[type=checkbox]') as HTMLInputElement | null;
    const marker = ordered ? `${n++}.` : '-';
    const task = box ? (box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    const indent = '  '.repeat(depth);
    const inner: string[] = [];
    const nested: string[] = [];
    let text = '';
    for (const child of Array.from(li.childNodes)) {
      const tag = child.nodeType === 1 ? (child as Element).tagName.toUpperCase() : '';
      if (tag === 'UL' || tag === 'OL') nested.push(renderList(child as Element, depth + 1));
      else if (tag === 'P' || tag === 'DIV') {
        if (text.trim()) inner.push(cleanInline(text));
        text = '';
        inner.push(cleanInline(inline(child, { pre: false, cell: false })));
      } else if (tag === 'PRE' || tag === 'BLOCKQUOTE' || tag === 'TABLE') {
        if (text.trim()) inner.push(cleanInline(text));
        text = '';
        inner.push(blocks(child, depth + 1).trim());
      } else text += inlineNode(child, { pre: false, cell: false });
    }
    if (text.trim()) inner.push(cleanInline(text));
    const pad = ' '.repeat(marker.length + 1);
    const body = inner
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .map((l, i) => (i === 0 ? l : l ? indent + pad + l : l))
      .join('\n');
    lines.push(`${indent}${marker} ${task}${body}`.replace(/\s+$/, ''));
    for (const nl of nested) if (nl) lines.push(nl);
  }
  return lines.join('\n');
}

function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
  if (!rows.length) return '';
  const grid = rows.map((tr) => Array.from(tr.children).filter((c) => /^(TD|TH)$/i.test(c.tagName)).map((c) => cleanInline(inline(c, { pre: false, cell: true })).replace(/\n/g, '<br>')));
  const cols = Math.max(...grid.map((r) => r.length));
  if (!cols) return '';
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
  const aligns = Array.from(rows[0].children).map((c) => ((c as HTMLElement).style?.textAlign || c.getAttribute('align') || '').toLowerCase());
  const delim = `| ${Array.from({ length: cols }, (_, i) => (aligns[i] === 'center' ? ':---:' : aligns[i] === 'right' ? '---:' : '---')).join(' | ')} |`;
  return [line(grid[0]), delim, ...grid.slice(1).map(line)].join('\n');
}

/** Block-level rendering: returns markdown blocks separated by blank lines. */
function blocks(root: Node, depth = 0): string {
  const out: string[] = [];
  let para = '';
  const flush = () => {
    const t = cleanInline(para);
    if (t) out.push(escapeLineStarts(t));
    para = '';
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType !== 1) {
      para += inlineNode(node, { pre: false, cell: false });
      continue;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) continue;
    const h = /^H([1-6])$/.exec(tag);
    if (h) {
      flush();
      const text = cleanInline(inline(el, { pre: false, cell: false })).replace(/\n+/g, ' ');
      if (text) out.push(`${'#'.repeat(+h[1])} ${text}`);
    } else if (tag === 'UL' || tag === 'OL') {
      flush();
      const l = renderList(el, 0);
      if (l) out.push(l);
    } else if (tag === 'PRE') {
      flush();
      const code = (el.textContent ?? '').replace(/\n$/, '');
      const f = fence(code);
      out.push(`${f}${langOf(el)}\n${code}\n${f}`);
    } else if (tag === 'BLOCKQUOTE') {
      flush();
      const inner = blocks(el, depth).trim();
      if (inner) out.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    } else if (tag === 'TABLE') {
      flush();
      const t = renderTable(el);
      if (t) out.push(t);
    } else if (tag === 'HR') {
      flush();
      out.push('---');
    } else if (BLOCK.has(tag) || tag === 'LI' || tag === 'BODY' || tag === 'HTML') {
      // Containers holding block children recurse; leaf blocks are paragraphs.
      if (Array.from(el.children).some((c) => BLOCK.has(c.tagName.toUpperCase()) || /^(H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|HR)$/i.test(c.tagName))) {
        flush();
        const inner = blocks(el, depth);
        if (inner) out.push(inner);
      } else {
        flush();
        para = inline(el, { pre: false, cell: false });
        flush();
      }
    } else para += inlineNode(el, { pre: false, cell: false });
  }
  flush();
  return out.join('\n\n');
}

/** Converts clipboard HTML to Markdown. Only the StartFragment…EndFragment part is used when present. */
export function htmlToMarkdown(html: string): string {
  const s = html.indexOf('<!--StartFragment-->');
  const e = html.indexOf('<!--EndFragment-->');
  const src = s >= 0 && e > s ? html.slice(s + 20, e) : html;
  const doc = new DOMParser().parseFromString(src, 'text/html');
  return blocks(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
