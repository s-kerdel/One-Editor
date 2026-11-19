// The print document behind "Export note to PDF": paper typography, smart page breaks, inlined images.
// Pure DOM + strings (no app singleton, no Vite imports) so it is unit-tested under jsdom.
import { pdfPageCss, type PdfLayout } from '@shared/pdf';
import { extname } from '@shared/paths';

/** Raw bytes of a workspace file, or null when it cannot be read. */
export type FileLoader = (wsPath: string, maxBytes: number) => Promise<Uint8Array | null>;

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** All inlined images together (base64 adds a third; the HTML cap is MAX_PDF_HTML_CHARS). */
export const MAX_IMAGES_TOTAL_BYTES = 40 * 1024 * 1024;
/** Longer blocks may split across pages; shorter ones are kept in one piece. */
export const LONG_CODE_LINES = 30;
export const LONG_TABLE_ROWS = 20;
const LONG_TEXT_CHARS = 1500;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/** What the hidden print window may load (sanitized content; this is the second layer). */
export const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; base-uri 'none'; form-action 'none'";

// Always the light palette, whatever the app theme (the hidden window follows the OS dark mode otherwise).
// Also on body>.se-preview: preview.css's print block re-declares tokens on .se-preview.
const TOKENS =
  ':root,body>.se-preview{color-scheme:light;--bg:#fff;--bg-elev:#fff;--bg-sunken:#f3f4f6;--bg-hover:#eceef1;--bg-active:#e2e4ea;--border:#dcdfe4;--text:#1a1c1f;--text-muted:#596069;--text-faint:#8d939b;' +
  '--accent:#2f5fd0;--accent-soft:rgba(47,95,208,.1);--danger:#c62828;--success:#1a7f37;--warning:#9a6700;--match-bg:rgba(255,210,0,.45);--code-bg:#f6f7f9;--selection:rgba(47,95,208,.2);' +
  "--radius-xs:3px;--radius-sm:4px;--radius:5px;--radius-md:6px;--radius-lg:8px;--radius-pill:999px;--font-text:'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Inter','Helvetica Neue',Arial,sans-serif;" +
  "--font-ui:var(--font-text);--font-mono:'Cascadia Mono','Cascadia Code','JetBrains Mono',Consolas,'SF Mono',Menlo,'DejaVu Sans Mono',monospace;--editor-font-size:10.5pt;--editor-line-height:1.58}";

// Paper typography. Loaded after preview.css (whose @media print block already handles most colours).
const PRINT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:var(--text)}
body>.se-preview{max-width:none;margin:0;padding:0!important;font-size:10.5pt;line-height:1.58;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.se-preview p,.se-preview li,.se-preview dd,.se-preview blockquote,.se-preview pre{orphans:3;widows:3}
.se-preview :is(h1,h2,h3,h4,h5,h6){break-after:avoid-page;break-inside:avoid;color:#111317}
.se-preview h1{font-size:21pt;line-height:1.2;margin:0 0 .5em;letter-spacing:-.015em}
.se-preview h2{font-size:15pt;margin:1.5em 0 .5em;padding-bottom:.25em}
.se-preview h3{font-size:12.5pt;margin:1.35em 0 .45em}
.se-preview h4{font-size:11pt}
.se-preview :is(h1,h2,h3,h4,h5,h6)+:is(p,ul,ol,.se-code,.se-table-wrap,.se-callout,blockquote,figure){break-before:avoid-page}
.se-preview .se-anchor,.se-preview .se-code-tools,.se-preview .se-code-copy{display:none!important}
.se-preview.markdown-body a{color:var(--accent);text-decoration:none}
.se-preview.markdown-body a[href]::after{content:none!important;display:none!important}
.se-preview .se-code{margin:.9em 0;border-radius:var(--radius-md);background:var(--code-bg);border:1px solid var(--border)}
.se-preview.markdown-body pre{padding:.7em .9em;font:8.6pt/1.5 var(--font-mono);white-space:pre-wrap;overflow:visible;tab-size:4}
.se-preview.markdown-body pre>code{display:block;width:auto;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.se-preview .se-code-numbers .line::before{width:2em;margin-right:.9em}
.se-preview.markdown-body :not(pre)>code{font-size:.88em;padding:.08em .35em;background:#eef0f3}
.se-preview :is(.se-code,.se-table-wrap,.se-callout,blockquote,.se-embed){break-inside:avoid}
.se-preview :is(.se-code,.se-table-wrap,.se-callout,blockquote,.se-embed).se-long{break-inside:auto}
.se-preview :is(img,svg,figure,tr,.se-mermaid,.se-math-display,.se-frontmatter){break-inside:avoid}
.se-preview .se-table-wrap{margin:1em 0;overflow:visible}
.se-preview table{width:100%;max-width:100%;font-size:9.4pt;border-collapse:collapse}
.se-preview thead{display:table-header-group}
.se-preview th,.se-preview td{padding:.36em .6em;overflow-wrap:break-word;word-break:normal;hyphens:auto}
.se-preview :is(td,th) :is(a,code){overflow-wrap:anywhere}
.se-preview thead th{white-space:normal;background:var(--bg-sunken)}
.se-preview tbody tr:hover{background:inherit}
.se-preview img{max-width:100%;height:auto;border-radius:var(--radius)}
.se-preview .se-mermaid{margin:1.1em 0;padding:8pt;background:#fff;border:1px solid var(--border);border-radius:var(--radius-md)}
.se-preview .se-mermaid>svg{max-width:100%;height:auto}
.se-preview .se-math-display{overflow:visible}
.se-preview .se-callout{margin:1em 0}
.se-preview details.se-callout>.se-callout-content{display:block}
.se-preview .se-callout-fold{display:none}
.se-preview input[type=checkbox]{border-color:#9aa0a8}
.se-preview hr{margin:1.6em 0}
.se-preview .se-page-break,.se-preview .page-break{display:block;height:0;margin:0;border:0;padding:0;break-after:page}
.se-preview .se-page-break::after,.se-preview .page-break::after{content:none}
.se-preview :is(.se-page-break,.page-break)+*{margin-top:0}
.se-preview .se-pdf-missing{display:inline-block;padding:.15em .55em;border:1px dashed var(--border);border-radius:var(--radius-sm);color:var(--text-muted);font-size:.85em}
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let bin = '';
  // Chunked: String.fromCharCode(...hugeArray) overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function placeholder(doc: Document, text: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'se-pdf-missing';
  span.textContent = text;
  return span;
}

/**
 * Workspace images (`![](rel.png)`, `![[img.png]]`, `<img src>`) → data: URIs, so the sandboxed print
 * window needs no file access at all. Media that cannot be shown on paper become labelled placeholders.
 * Returns how many images were inlined.
 */
export async function inlineImages(root: HTMLElement, load: FileLoader, budget = MAX_IMAGES_TOTAL_BYTES): Promise<number> {
  const doc = root.ownerDocument;
  const cache = new Map<string, Promise<string | null>>();
  let inlined = 0;
  const dataUri = (ws: string) => {
    let p = cache.get(ws);
    if (!p) {
      p = (async () => {
        const mime = IMAGE_MIME[extname(ws)];
        if (!mime) return null;
        const bytes = await load(ws, Math.min(MAX_IMAGE_BYTES, budget)).catch(() => null);
        if (!bytes || bytes.length > budget) return null;
        budget -= bytes.length;
        return `data:${mime};base64,${base64(bytes)}`;
      })();
      cache.set(ws, p);
    }
    return p;
  };
  const jobs = [...root.querySelectorAll<HTMLImageElement>('img')].map(async (img) => {
    img.removeAttribute('loading'); // the hidden window may never "scroll" a lazy image into view
    img.removeAttribute('srcset');
    const ws = img.getAttribute('data-ws-src');
    const label = img.getAttribute('alt') || ws || img.getAttribute('src') || 'image';
    if (ws !== null) {
      const uri = img.classList.contains('is-unresolved') ? null : await dataUri(ws);
      if (uri) {
        img.setAttribute('src', uri);
        inlined++;
      } else img.replaceWith(placeholder(doc, `Image not found: ${label}`));
      return;
    }
    const src = img.getAttribute('src') ?? '';
    // Remote https images load like in the preview; anything else (http:, file:, blob:) cannot.
    if (!/^(https:|data:image\/)/i.test(src)) img.replaceWith(placeholder(doc, `Image: ${label}`));
  });
  await Promise.all(jobs);
  for (const m of root.querySelectorAll('video, audio')) {
    const name = (m.getAttribute('data-ws-src') ?? m.getAttribute('src') ?? '').split('/').pop() || m.nodeName.toLowerCase();
    m.replaceWith(placeholder(doc, `${m.nodeName === 'VIDEO' ? 'Video' : 'Audio'}: ${name}`));
  }
  return inlined;
}

/** Paper-only DOM tweaks: no properties block, folded callouts open, long blocks may split, `\pagebreak`. */
export function preparePrintDom(root: HTMLElement): void {
  // Properties (YAML frontmatter) are metadata, not part of the document: the title comes first.
  root.querySelectorAll('.se-frontmatter').forEach((n) => n.remove());
  for (const d of root.querySelectorAll('details')) d.setAttribute('open', '');
  for (const el of root.querySelectorAll<HTMLElement>('.se-code')) {
    if ((el.textContent ?? '').split('\n').length > LONG_CODE_LINES) el.classList.add('se-long');
  }
  for (const el of root.querySelectorAll<HTMLElement>('.se-table-wrap')) {
    if (el.querySelectorAll('tr').length > LONG_TABLE_ROWS) el.classList.add('se-long');
  }
  for (const el of root.querySelectorAll<HTMLElement>('.se-callout, blockquote, .se-embed')) {
    if ((el.textContent ?? '').length > LONG_TEXT_CHARS || el.querySelector('.se-long')) el.classList.add('se-long');
  }
  // Pandoc / LaTeX habit inside a paragraph that the block rule did not see (e.g. typed inside a list).
  for (const p of root.querySelectorAll('p')) {
    const t = p.textContent?.trim();
    if (t === '\\pagebreak' || t === '\\newpage') {
      const br = root.ownerDocument.createElement('div');
      br.className = 'se-page-break';
      p.replaceWith(br);
    }
  }
}

/** The complete print document: light palette, preview styles, paper typography and the @page box. */
export function assemblePdfHtml(o: { title: string; body: string; css: string; layout: PdfLayout }): string {
  return (
    `<!doctype html>\n<html lang="en" data-theme="light">\n<head>\n<meta charset="utf-8">\n<meta name="generator" content="sec-edit">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">\n<title>${esc(o.title)}</title>\n` +
    `<style>${TOKENS}\n${o.css}\n${PRINT_CSS}\n${pdfPageCss(o.layout)}</style>\n</head>\n` +
    `<body>\n<main class="se-preview markdown-body">\n${o.body}\n</main>\n</body>\n</html>\n`
  );
}
