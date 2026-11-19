// Markdown autocompletion: [[note]] / [[note#heading]], ```language, #tags.
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { LANGUAGES } from '@shared/languages';
import { basename, dirname, isMarkdown, stem } from '@shared/paths';
import { resolveWikiTarget } from '@shared/wikilinks';
import { docPath } from './host';
import { inCodeContext } from './mdkeys';

export interface CompletionHost {
  files(): readonly string[];
  /** Text of a workspace file (open docs first, else read from disk). */
  readText(path: string): Promise<string | null>;
  tags(): string[];
  /** Indexed headings of a note (cheaper than reading it), or null to fall back to readText. */
  headings?(path: string): Array<{ text: string; level: number }> | null;
  recent?(): readonly string[];
}

/** Link text for a file: shortest name that still resolves to it (Obsidian style). */
export function linkTextFor(file: string, files: readonly string[], from: string): string {
  const name = isMarkdown(file) ? stem(file) : basename(file);
  if (resolveWikiTarget(name, files, from) === file) return name;
  return isMarkdown(file) ? file.replace(/\.(md|markdown|mdx)$/i, '') : file;
}

export function headingsOf(text: string): Array<{ text: string; level: number }> {
  const out: Array<{ text: string; level: number }> = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

const closeWith = (view: EditorView, to: number) => (view.state.sliceDoc(to, to + 2) === ']]' ? '' : ']]');

function wikiSource(host: CompletionHost): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = /(!?)\[\[([^[\]|#\n]*)(#\^?([^[\]|\n]*))?$/.exec(before);
    if (!m || inCodeContext(ctx.state, ctx.pos)) return null;
    const from = ctx.state.facet(docPath);
    const files = host.files();
    if (m[3] !== undefined) {
      // [[Note#heading
      const target = m[2] ? resolveWikiTarget(m[2], files, from) : from;
      if (!target || !isMarkdown(target)) return null;
      let heads = target === from ? null : host.headings?.(target) ?? null;
      if (!heads) {
        const text = target === from ? ctx.state.doc.toString() : await host.readText(target);
        if (text == null || ctx.aborted) return null;
        heads = headingsOf(text);
      }
      const options: Completion[] = heads.map((h, i) => ({
        label: h.text,
        detail: 'H' + h.level,
        type: 'heading',
        boost: -i / 1000,
        apply: (view, _c, a, b) => {
          const insert = h.text + closeWith(view, b);
          view.dispatch({ changes: { from: a, to: b, insert }, selection: { anchor: a + insert.length + (insert.endsWith(']]') ? 0 : 2) } });
        },
      }));
      return { from: ctx.pos - m[4].length, options, validFor: /^[^[\]|\n]*$/ };
    }
    const embed = m[1] === '!';
    const recent = new Set(host.recent?.() ?? []);
    const options: Completion[] = [];
    for (const f of files) {
      if (f === from) continue;
      const md = isMarkdown(f);
      if (!embed && !md && !/\.(png|jpe?g|gif|webp|svg|pdf|canvas)$/i.test(f)) continue;
      const label = md ? stem(f) : basename(f);
      const dir = dirname(f);
      options.push({
        label,
        detail: dir || undefined,
        type: md ? 'text' : 'file',
        boost: recent.has(f) ? 2 : md ? 1 : 0,
        apply: (view, _c, a, b) => {
          const insert = linkTextFor(f, files, from) + closeWith(view, b);
          view.dispatch({ changes: { from: a, to: b, insert }, selection: { anchor: a + insert.length + (insert.endsWith(']]') ? 0 : 2) } });
        },
      });
    }
    return { from: ctx.pos - m[2].length, options, validFor: /^[^[\]|#\n]*$/ };
  };
}

const fenceOptions: Completion[] = (() => {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const l of LANGUAGES) {
    for (const a of [l.id, ...l.aliases]) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push({ label: a, detail: a === l.id ? l.name : `${l.name}`, type: 'keyword', boost: a === l.id ? 1 : 0 });
    }
  }
  return out;
})();

const fenceSource: CompletionSource = (ctx) => {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /^(\s*(?:>\s*)*)(`{3,}|~{3,})([\w+#.-]*)$/.exec(before);
  if (!m) return null;
  if (!m[3] && !ctx.explicit) return null;
  // Only on an opening fence, not the closing one of an existing block.
  for (let n: { name: string; from: number; parent: any } | null = syntaxTree(ctx.state).resolveInner(line.from + m[1].length, 1); n; n = n.parent) {
    if (n.name === 'FencedCode' && n.from < line.from) return null;
  }
  return { from: ctx.pos - m[3].length, options: fenceOptions, validFor: /^[\w+#.-]*$/ };
};

function tagSource(host: CompletionHost): CompletionSource {
  return (ctx) => {
    const m = ctx.matchBefore(/(^|[\s(])#[\p{L}\p{N}_\-/]*$/u);
    if (!m || inCodeContext(ctx.state, ctx.pos)) return null;
    const hash = m.from + m.text.indexOf('#');
    const typed = ctx.state.sliceDoc(hash + 1, ctx.pos);
    const line = ctx.state.doc.lineAt(ctx.pos);
    // "#" at line start is probably a heading being typed.
    if (hash === line.from && !typed && !ctx.explicit) return null;
    // The tag being typed is itself in the scanned docs; offering it back is noise.
    const tags = host.tags().filter((t) => t !== typed);
    if (!tags.length) return null;
    return { from: hash + 1, options: tags.map((t) => ({ label: t, type: 'constant' })), validFor: /^[\p{L}\p{N}_\-/]*$/u };
  };
}

export function markdownCompletionSources(host: CompletionHost): CompletionSource[] {
  return [wikiSource(host), fenceSource, tagSource(host)];
}

/** Tags from text (excluding fenced code). */
export function scanTags(text: string, into: Map<string, number>) {
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const m of line.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_\-/]+)/gu)) {
      const t = m[1];
      if (/^[\d/-]+$/.test(t)) continue;
      into.set(t, (into.get(t) ?? 0) + 1);
    }
  }
}
