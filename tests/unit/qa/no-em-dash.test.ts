// Guard: no em dash (or en dash) in text the app shows: titles, toasts, tooltips, dialogs, errors.
// Only string literals, template parts and JSX text are checked, so comments keep theirs.
// TypeScript 7 has no JS parser (no ts.createSourceFile): the AST comes from the native compiler
// through its sync API (typescript/unstable/*), one spawn for the whole project.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind, type Node } from 'typescript/unstable/ast';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = path.join(ROOT, 'src');
// The dashes themselves, written as \u escapes (cooked text) or as HTML entities in JSX.
const DASH = /[\u2013\u2014]|&[mn]dash;|&#(?:821[12]|x201[34]);/i;
const MAYBE = new RegExp(`${DASH.source}|\\\\u\\{?0*201[34]`, 'i'); // files worth parsing: a \u2014 escape counts too
// Data, not text: the Windows-1252 decode table maps bytes 0x96 / 0x97 to the dashes.
const DATA_FILES = new Set(['src/backend/textcodec.ts']);
const TEXT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
  SyntaxKind.JsxText,
]);

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

// Comments become blanks with the same line breaks, so a hit still reports its real line.
function textHits(abs: string, comments: RegExp): string[] {
  const text = readFileSync(abs, 'utf8').replace(comments, (c) => c.replace(/[^\n]/g, ' '));
  return text.split('\n').flatMap((l, i) => (DASH.test(l) ? [`${rel(abs)}:${i + 1}: ${l.trim()}`] : []));
}

describe('no em dash in user-visible text', () => {
  const api = new API({ cwd: ROOT });
  afterAll(() => api.close());

  it('string literals, template parts and JSX text under src/', () => {
    const program = api.updateSnapshot({ openProjects: [path.join(ROOT, 'tsconfig.json')] }).getProjects()[0].program;
    const all = files(SRC, /\.tsx?$/);
    const hits: string[] = [];
    const missing: string[] = [];
    for (const abs of all) {
      if (DATA_FILES.has(rel(abs))) continue;
      if (!MAYBE.test(readFileSync(abs, 'utf8'))) continue; // most files have none at all
      const sf = program.getSourceFile(abs);
      if (!sf) {
        missing.push(rel(abs));
        continue;
      }
      const visit = (n: Node): void => {
        if (TEXT_KINDS.has(n.kind)) {
          const raw = n.getText(sf);
          if (DASH.test(raw) || DASH.test((n as Node & { text: string }).text)) {
            hits.push(`${rel(abs)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${raw.trim().slice(0, 120)}`);
          }
        }
        n.forEachChild(visit);
      };
      visit(sf);
    }
    expect(all.length).toBeGreaterThan(100);
    expect(missing, 'files the compiler did not parse').toEqual([]);
    expect(hits, 'use a colon, comma, parentheses or a period; " - " in titles').toEqual([]);
  });

  it('CSS (content: strings) and index.html, outside comments', () => {
    const hits = [
      ...files(SRC, /\.css$/).flatMap((f) => textHits(f, /\/\*[\s\S]*?\*\//g)),
      ...textHits(path.join(SRC, 'renderer/index.html'), /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g),
    ];
    expect(hits).toEqual([]);
  });

  it('the checks see a dash where one is', () => {
    expect(DASH.test('notes.md — One')).toBe(true);
    expect(DASH.test('lines 3–4')).toBe(true);
    expect(DASH.test('a &mdash; b')).toBe(true);
    expect(DASH.test('notes.md - One :: folder')).toBe(false);
  });
});
