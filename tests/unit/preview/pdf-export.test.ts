// @vitest-environment jsdom
// The print document behind "Export note to PDF": light theme, @page box per size/margin, inlined images,
// print-only DOM tweaks, manual page breaks.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PDF_LAYOUT, PDF_MARGIN_MM, PDF_PAGE_MM, pdfLayoutFrom, pdfPageCss, printToPdfOptions, type PdfLayout } from '../../../src/shared/pdf';
import { LONG_CODE_LINES, MAX_IMAGE_BYTES, PDF_CSP, assemblePdfHtml, inlineImages, preparePrintDom } from '../../../src/renderer/preview/pdf-doc';
import { renderMarkdown } from '../../../src/renderer/preview/markdown';

const FILES = ['notes/report.md', 'notes/img/chart.png', 'assets/logo.svg', 'notes/clip.mp4', 'notes/doc.pdf'];
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function render(src: string, remote = true) {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(src, { path: 'notes/report.md', files: FILES, sourceLines: false, remote });
  return el;
}

describe('page layout', () => {
  it('settings → layout, unknown values fall back to the defaults', () => {
    expect(pdfLayoutFrom({})).toEqual(DEFAULT_PDF_LAYOUT);
    expect(DEFAULT_PDF_LAYOUT).toEqual({ pageSize: 'A4', margins: 'normal', pageNumbers: true });
    expect(pdfLayoutFrom({ 'export.pdfPageSize': 'Legal', 'export.pdfMargins': 'wide', 'export.pdfPageNumbers': false })).toEqual({ pageSize: 'Legal', margins: 'wide', pageNumbers: false });
    expect(pdfLayoutFrom({ 'export.pdfPageSize': 'A0', 'export.pdfMargins': 'huge', 'export.pdfPageNumbers': 'yes' })).toEqual(DEFAULT_PDF_LAYOUT);
    expect(pdfLayoutFrom({ 'export.pdfPageSize': 'toString' })).toEqual(DEFAULT_PDF_LAYOUT); // own keys only
  });

  it('@page CSS for every size × margin preset', () => {
    const sizes = { A4: '210mm 297mm', Letter: '215.9mm 279.4mm', Legal: '215.9mm 355.6mm' } as const;
    const margins = { narrow: '12mm 12mm 14mm 12mm', normal: '20mm 20mm 22mm 20mm', wide: '25mm 32mm 27mm 32mm' } as const;
    for (const [size, box] of Object.entries(sizes)) {
      for (const [m, css] of Object.entries(margins)) {
        const page = pdfPageCss({ pageSize: size as PdfLayout['pageSize'], margins: m as PdfLayout['margins'], pageNumbers: true });
        expect(page).toContain(`@page{size:${box};margin:${css}}`);
        // Images are capped to the text area height, so a tall screenshot is never sliced in two.
        const mm = PDF_MARGIN_MM[m as PdfLayout['margins']];
        const cap = Number(/max-height:(\d+)mm/.exec(page)![1]);
        expect(cap).toBeLessThan(PDF_PAGE_MM[size as PdfLayout['pageSize']].height - mm.top - mm.bottom);
      }
    }
  });

  it('printToPDF options match the CSS (inches) and only show a footer when page numbers are on', () => {
    const on = printToPdfOptions({ pageSize: 'Letter', margins: 'normal', pageNumbers: true });
    expect(on).toMatchObject({ pageSize: 'Letter', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true });
    expect(on.margins.top).toBeCloseTo(20 / 25.4, 2);
    expect(on.margins.bottom).toBeCloseTo(22 / 25.4, 2);
    expect(on.footerTemplate).toContain('<span class="pageNumber"></span> / <span class="totalPages"></span>');
    expect(on.headerTemplate).not.toContain('title'); // no default date/title header
    const off = printToPdfOptions({ pageSize: 'A4', margins: 'narrow', pageNumbers: false });
    expect(off.displayHeaderFooter).toBe(false);
    expect(off.footerTemplate).not.toContain('pageNumber');
  });
});

describe('assemblePdfHtml', () => {
  const html = assemblePdfHtml({ title: 'Q3 <Report> & "more"', body: '<h1>Hi</h1>', css: '.se-preview{color:var(--text)}', layout: DEFAULT_PDF_LAYOUT });

  it('is a standalone document that always uses the light theme', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('color-scheme:light');
    expect(html).toContain('--bg:#fff');
    expect(html).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(html).toContain('<main class="se-preview markdown-body">\n<h1>Hi</h1>');
    expect(html).toContain('<title>Q3 &lt;Report&gt; &amp; &quot;more&quot;</title>');
    expect(html).toContain('@page{size:210mm 297mm;margin:20mm 20mm 22mm 20mm}');
  });

  it('carries a CSP without scripts, frames or remote fetches (images: data + https only)', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">`);
    expect(PDF_CSP).toContain("default-src 'none'");
    expect(PDF_CSP).toContain('img-src data: https:');
    expect(PDF_CSP).not.toMatch(/script-src|unsafe-eval|file:|blob:/);
    expect(html).not.toMatch(/<script|<link /i);
  });

  it('print rules: headings stick to the next block, long code wraps, rows never split, page-break markers', () => {
    expect(html).toMatch(/:is\(h1,h2,h3,h4,h5,h6\)\{break-after:avoid-page/);
    expect(html).toMatch(/pre>code\{[^}]*white-space:pre-wrap/);
    expect(html).toMatch(/:is\(img,svg,figure,tr,[^)]*\)\{break-inside:avoid\}/);
    expect(html).toMatch(/\.se-long\{break-inside:auto\}/);
    expect(html).toMatch(/\.page-break\{[^}]*break-after:page/);
  });
});

describe('inlineImages', () => {
  it('turns workspace images (markdown, wiki embeds, raw <img>) into data URIs; one read per file', async () => {
    const el = render('![chart](img/chart.png)\n\n![[chart.png|200]]\n\n<img src="../assets/logo.svg" alt="logo">\n\n![remote](https://example.com/a.png)');
    const reads: string[] = [];
    const n = await inlineImages(el, async (p) => (reads.push(p), p.endsWith('.svg') ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') : PNG));
    expect(n).toBe(3);
    const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src')!);
    expect(srcs[0]).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
    expect(srcs[1]).toBe(srcs[0]);
    expect(srcs[2]).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(srcs[3]).toBe('https://example.com/a.png'); // remote images load like in the preview
    expect(reads.sort()).toEqual(['assets/logo.svg', 'notes/img/chart.png']);
    expect(el.querySelector('img[loading]')).toBeNull(); // lazy images might never load in a hidden window
    expect(el.querySelector('img')!.getAttribute('width')).toBeNull();
    expect(el.querySelectorAll('img')[1].getAttribute('width')).toBe('200');
  });

  it('remote images the note may not load are labelled placeholders on paper too', async () => {
    const el = render('![remote](https://example.com/a.png)', false);
    await inlineImages(el, async () => PNG);
    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(el.querySelector('.se-pdf-missing')!.textContent).toBe('Image: remote');
  });

  it('missing, unreadable, oversized or non-image files become a labelled placeholder (no broken icon)', async () => {
    const el = render('![gone](img/missing.png)\n\n![[nope.png]]\n\n![big](img/chart.png)\n\n<img src="doc.pdf" alt="pdf">\n\n<img src="http://insecure.example/x.png" alt="http">\n\n![[clip.mp4]]');
    let max = 0;
    await inlineImages(el, async (p, m) => {
      max = m;
      if (p === 'notes/img/chart.png') return null; // what the loader returns for a file over the cap
      throw new Error('ENOENT');
    });
    expect(max).toBe(MAX_IMAGE_BYTES);
    expect(el.querySelectorAll('img')).toHaveLength(0);
    const labels = [...el.querySelectorAll('.se-pdf-missing')].map((s) => s.textContent);
    expect(labels).toEqual(['Image not found: gone', 'Image not found: nope.png', 'Image not found: big', 'Image not found: pdf', 'Image: http', 'Video: clip.mp4']);
  });

  it('stops inlining once the total budget is spent', async () => {
    const el = render(Array.from({ length: 4 }, (_, i) => `![i${i}](img/p${i}.png)`).join('\n\n'));
    const chunk = new Uint8Array(1500);
    const n = await inlineImages(el, async (_p, m) => (chunk.length <= m ? chunk : null), 4000);
    expect(n).toBe(2);
    expect(el.querySelectorAll('.se-pdf-missing').length).toBe(2);
  });
});

describe('preparePrintDom', () => {
  it('drops the properties block, opens folded callouts, marks long blocks so they may split', () => {
    const short = '```js\nconst a = 1;\n```';
    const long = '```js\n' + Array.from({ length: LONG_CODE_LINES + 5 }, (_, i) => `line${i}`).join('\n') + '\n```';
    const table = '| a | b |\n|---|---|\n' + Array.from({ length: 30 }, (_, i) => `| ${i} | x |`).join('\n');
    const el = render(`---\ntitle: T\n---\n\n# T\n\n${short}\n\n${long}\n\n${table}\n\n> [!tip]- Folded\n> hidden body`);
    preparePrintDom(el);
    expect(el.querySelector('.se-frontmatter')).toBeNull();
    const codes = el.querySelectorAll('.se-code');
    expect(codes[0].classList.contains('se-long')).toBe(false);
    expect(codes[1].classList.contains('se-long')).toBe(true);
    expect(el.querySelector('.se-table-wrap')!.classList.contains('se-long')).toBe(true);
    const det = el.querySelector('details.se-callout')!;
    expect(det.hasAttribute('open')).toBe(true);
    expect(det.textContent).toContain('hidden body');
  });
});

describe('manual page breaks', () => {
  it('a line with only \\pagebreak or \\newpage becomes a page-break block', () => {
    const el = render('one\n\n\\pagebreak\n\ntwo\n\\newpage\n\nthree');
    expect(el.querySelectorAll('.se-page-break')).toHaveLength(2);
    expect(el.textContent).not.toContain('\\pagebreak');
    expect(el.textContent).not.toContain('\\newpage');
    expect(el.querySelector('.se-page-break')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('only as a whole line, never inside code; raw <div class="page-break"> survives sanitizing', () => {
    const el = render('see \\pagebreak here\n\n```\n\\pagebreak\n```\n\n    \\pagebreak\n\n<div class="page-break"></div>');
    expect(el.querySelectorAll('.se-page-break')).toHaveLength(0);
    expect(el.querySelectorAll('div.page-break')).toHaveLength(1);
    expect(el.textContent).toContain('see \\pagebreak here');
  });

  it('keeps editor ↔ preview line mapping (data-line) for the marker', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown('a\n\n\\pagebreak\n\nb', { path: 'x.md', files: [] });
    expect(el.querySelector('.se-page-break')!.getAttribute('data-line')).toBe('2');
  });

  it('\\pagebreak typed inside a list item is still honoured by the print DOM', () => {
    const el = render('- item\n\n  \\pagebreak\n\n- next');
    preparePrintDom(el);
    expect(el.querySelectorAll('.se-page-break').length).toBeGreaterThanOrEqual(1);
  });
});
