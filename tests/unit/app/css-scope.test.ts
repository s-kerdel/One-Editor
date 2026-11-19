// Lazily loaded stylesheets must not restyle shared app.css components globally: they arrive after
// first paint, so an unscoped `.se-btn {…}` visibly resizes buttons/icons app-wide a moment later.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/renderer');
const appCss = fs.readFileSync(path.join(root, 'styles/app.css'), 'utf8');

/** Selectors of every rule (skips @-rule preludes; descends into @media blocks). */
function selectors(css: string): string[] {
  const out: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@') || /^(from|to|\d+%)/.test(sel)) continue;
    out.push(...sel.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/** Classes app.css styles as standalone components (first compound of a selector). */
const shared = new Set<string>();
for (const sel of selectors(appCss)) {
  const first = sel.split(/[\s>+~]+/)[0];
  if (/^\.se-[\w-]+/.test(first)) shared.add(first.match(/^\.se-[\w-]+/)![0]);
}

function lazySheets(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return lazySheets(p);
    return e.name.endsWith('.css') && p !== path.join(root, 'styles/app.css') ? [p] : [];
  });
}

/** A module may style its own root element (app.css only holds a fallback for it). */
const OWN_ROOT: Record<string, string[]> = {
  'editor/editor.css': ['.se-editor'],
  'preview/preview.css': ['.se-preview'],
  'search/search.css': ['.se-palette'], // the palette/omnibox is the search module's own overlay
};

describe('lazy CSS does not restyle shared components globally', () => {
  for (const file of lazySheets(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    it(rel, () => {
      const bad = selectors(fs.readFileSync(file, 'utf8')).filter((sel) => {
        const first = sel.split(/[\s>+~]+/)[0];
        const cls = first.match(/^\.se-[\w-]+/)?.[0];
        // A rule that STARTS at a shared class (`.se-btn`, `.se-icon-btn svg`, …) applies app-wide → must be
        // scoped under the module's own container (e.g. `.se-search .se-btn`).
        // Qualified starts (`.se-settings.se-prefs`, `.se-overlay:has(> .se-prefs)`) are scoped already.
        const bare = /^\.se-[\w-]+(?::(?!has\b)[\w-]+(?:\([^)]*\))?)*$/.test(first);
        return !!cls && bare && shared.has(cls) && !OWN_ROOT[rel]?.includes(cls);
      });
      expect(bad, `scope these under the module's own container`).toEqual([]);
    });
  }
});
