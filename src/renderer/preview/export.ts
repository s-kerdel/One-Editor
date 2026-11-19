// Standalone HTML export + rich clipboard copy. Loaded lazily (only when one of the commands runs).
import css from './preview.css?inline';
import { app } from '../app/app';
import { stem } from '@shared/paths';
import { renderMarkdown } from './markdown';
import { enhanceAll } from './enhance';
import { expandEmbeds } from './embeds';
import { embedContext, renderOptionsFor } from './index';

// Mirrors the design tokens of styles/app.css so an exported file looks like the app (light by
// default, dark when the reader's system prefers it). data-theme="system" reuses preview.css as-is.
const TOKENS = `
:root{--bg:#1b1d22;--bg-elev:#22252b;--bg-sunken:#16181c;--bg-hover:#2a2e36;--bg-active:#323844;--border:#2f333b;--text:#d7dae0;--text-muted:#8b919c;--text-faint:#5f6570;--accent:#7aa2f7;--accent-soft:rgba(122,162,247,.16);--danger:#f7768e;--success:#9ece6a;--warning:#e0af68;--match-bg:rgba(224,175,104,.35);--code-bg:#15171b;--selection:rgba(122,162,247,.28);--radius:6px;color-scheme:dark;
--font-text:'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Inter',sans-serif;--font-ui:var(--font-text);--font-mono:'Cascadia Code','JetBrains Mono','Fira Code',Consolas,'SF Mono',Menlo,monospace;--editor-font-size:16px}
@media (prefers-color-scheme: light){:root{--bg:#fbfbfa;--bg-elev:#fff;--bg-sunken:#f2f2f0;--bg-hover:#ececea;--bg-active:#e2e4ea;--border:#e1e1de;--text:#1f2328;--text-muted:#646b75;--text-faint:#9aa0a8;--accent:#3b6ee8;--accent-soft:rgba(59,110,232,.12);--danger:#d1242f;--success:#1a7f37;--warning:#9a6700;--match-bg:rgba(255,200,0,.4);--code-bg:#f4f4f2;--selection:rgba(59,110,232,.2);color-scheme:light}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text)}
body>.se-preview{padding:48px 32px 96px}
.se-mermaid{background:#fff;border-radius:8px;padding:12px}
.se-mermaid.is-error{background:none}
`;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fully rendered, self-sufficient DOM for a note (embeds expanded, code highlighted, math as MathML).
 *  `prepare` runs while media still carry their workspace path (data-ws-src): the PDF export inlines them. */
export async function renderStandalone(path: string, src: string, prepare?: (box: HTMLElement) => Promise<void>): Promise<HTMLElement> {
  const box = document.createElement('div');
  // {{variables}} resolve on export unless switched off (secrets are always masked): load their data first.
  await app.variables?.prepare(path).catch(() => {});
  // No resolveUrl: images keep their relative paths, which stay valid next to the note.
  box.innerHTML = renderMarkdown(src, { ...renderOptionsFor(path, { export: true }), resolveUrl: undefined, sourceLines: false });
  await expandEmbeds(box, { ...embedContext, render: (s, p) => renderMarkdown(s, { ...renderOptionsFor(p, { export: true }), resolveUrl: undefined, sourceLines: false, frontmatter: false }) }, [path]);
  box.querySelectorAll('[data-raw]').forEach((n) => (n.removeAttribute('data-raw'), n.removeAttribute('data-info')));
  // MathML needs no stylesheet or fonts; mermaid is rendered with the light theme on a white card.
  await enhanceAll(box, { mathOutput: 'mathml', dark: false });
  box.querySelectorAll('.se-code-copy').forEach((n) => n.remove());
  await prepare?.(box);
  box.querySelectorAll('[data-ws-src]').forEach((n) => n.removeAttribute('data-ws-src'));
  box.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((n) => (n.disabled = true));
  // Ids DOMPurify withheld inside the app (DOM clobbering guard) are safe in a standalone file.
  box.querySelectorAll<HTMLElement>('[data-slug]').forEach((h) => (h.id = h.dataset.slug!));
  return box;
}

export async function buildHtmlDocument(path: string, src: string): Promise<string> {
  const box = await renderStandalone(path, src);
  const title = box.querySelector('h1')?.textContent?.trim() || stem(path);
  return (
    `<!doctype html>\n<html lang="en" data-theme="system">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="sec-edit">\n` +
    // Content is already sanitized; the CSP is a second layer for a file that leaves the app.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src * data: file: blob:; font-src data:">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>${TOKENS}${css}</style>\n</head>\n` +
    `<body>\n<main class="se-preview markdown-body">\n${box.innerHTML}\n</main>\n</body>\n</html>\n`
  );
}

export async function exportHtml(path: string, src: string): Promise<void> {
  const html = await buildHtmlDocument(path, src);
  const out = path.replace(/\.[^./]+$/, '') + '.html';
  if (app.backend.kind === 'web') {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = out.split('/').pop()!;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    app.toast(`Downloaded ${a.download}`, 'success');
    return;
  }
  if (app.files.value.includes(out)) {
    // Never clobber a file silently — it may be hand-written HTML that shares the note's name.
    if (!confirm(`"${out}" already exists.\n\nOverwrite it with the exported note?`)) {
      app.toast('Export cancelled', 'info');
      return;
    }
    await app.backend.writeFile(out, html);
  } else await app.backend.createFile(out, html);
  app.toast(`Exported to ${out}`, 'success');
}

export async function copyHtml(path: string, src: string): Promise<void> {
  const box = await renderStandalone(path, src);
  box.querySelectorAll('.se-code-tools, .se-anchor').forEach((n) => n.remove());
  // Paste targets (mail, docs) ignore CSS variables: bake the light syntax colours in.
  for (const span of box.querySelectorAll<HTMLElement>('.se-code [style*="--shiki-light"]')) {
    const color = span.style.getPropertyValue('--shiki-light');
    span.removeAttribute('style');
    if (color) span.style.color = color;
  }
  const html = box.innerHTML;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([html], { type: 'text/plain' }) })]);
  } catch {
    await navigator.clipboard.writeText(html);
  }
  app.toast('Copied as HTML', 'success');
}
