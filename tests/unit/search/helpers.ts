import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SearchEngine } from '../../../src/search/engine';
import type { SearchResponse } from '../../../src/search/types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../fixtures/workspace');

export function fixtureDocs() {
  const out: Array<{ path: string; content: string }> = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else out.push({ path: path.relative(FIXTURES, p).split(path.sep).join('/'), content: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(FIXTURES);
  return out;
}

export function engineWith(docs: Record<string, string> | Array<{ path: string; content: string }>) {
  const e = new SearchEngine();
  const list = Array.isArray(docs) ? docs : Object.entries(docs).map(([p, content]) => ({ path: p, content }));
  e.reset(list);
  return e;
}

export const paths = (r: SearchResponse) => r.results.map((x) => x.path);
/** "path:line:context[/lang]:matchedText" for every row's first hit */
export const rows = (r: SearchResponse) => r.results.flatMap((x) => x.matches.map((m) => `${x.path}:${m.line}:${m.context}${m.lang ? '/' + m.lang : ''}:${m.lineText.slice(m.start, m.end)}`));
export const hitTexts = (r: SearchResponse) => r.results.flatMap((x) => x.matches.flatMap((m) => (m.ranges ?? [m]).map((rg) => m.lineText.slice(rg.start, rg.end))));
