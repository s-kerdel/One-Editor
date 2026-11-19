// Code-file support: lazy language loading (language-data), comment-token fallbacks, indent guides.
import { EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { LanguageDescription, getIndentUnit, type LanguageSupport } from '@codemirror/language';
import { completeAnyWord } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { languageById, languageForPath, type LanguageInfo } from '@shared/languages';
import { basename } from '@shared/paths';

/** Grammar for a doc: by path, or by a `languages.ts` id when the user overrode it ('text' = none). */
export function describeLanguage(path: string, overrideId?: string | null): { info: LanguageInfo | null; desc: LanguageDescription | null } {
  if (overrideId) {
    const info = languageById(overrideId);
    if (info?.id === 'text') return { info, desc: null };
    const names = info ? [info.cm, info.name, ...info.aliases] : [overrideId];
    for (const n of names) {
      const desc = n ? LanguageDescription.matchLanguageName(languages, n, false) : null;
      if (desc) return { info, desc };
    }
    return { info, desc: null };
  }
  const info = languageForPath(path);
  let desc = info?.cm ? LanguageDescription.matchLanguageName(languages, info.cm, false) : null;
  if (!desc && !info) desc = LanguageDescription.matchFilename(languages, basename(path));
  return { info, desc };
}

/** Language chosen by the file name alone (`languages.ts` id + display name). */
export function autoLanguage(path: string): { id: string; name: string } {
  const info = languageForPath(path);
  if (info) return { id: info.id, name: info.name };
  const desc = LanguageDescription.matchFilename(languages, basename(path));
  return desc ? { id: desc.name.toLowerCase(), name: desc.name } : { id: 'text', name: 'Plain text' };
}

/** Loads (and caches, via LanguageDescription) the grammar for a code file. */
export async function loadLanguage(path: string, overrideId?: string | null): Promise<LanguageSupport | null> {
  const { desc } = describeLanguage(path, overrideId);
  if (!desc) return null;
  try {
    return desc.support ?? (await desc.load());
  } catch (err) {
    console.warn('[editor] language load failed', path, err);
    return null;
  }
}

/** Grammar if it has been loaded before (lets a re-created state highlight on its first frame). */
export function loadedLanguage(path: string, overrideId?: string | null): LanguageSupport | null {
  return describeLanguage(path, overrideId).desc?.support ?? null;
}

/** Comment tokens from the shared language table for grammars that lack them (legacy modes). */
export function languageDataFallback(path: string, overrideId?: string | null): Extension {
  const info = overrideId ? languageById(overrideId) : languageForPath(path);
  const data: Record<string, unknown> = { autocomplete: completeAnyWord };
  if (info?.comment) data.commentTokens = { line: info.comment.line, block: info.comment.block ? { open: info.comment.block[0], close: info.comment.block[1] } : undefined };
  return EditorState.languageData.of(() => [data]);
}

const guideCache = new Map<number, Decoration>();
function guideDeco(levels: number, unit: number): Decoration {
  const key = levels * 100 + unit;
  let d = guideCache.get(key);
  if (!d) guideCache.set(key, (d = Decoration.mark({ class: 'se-indent-guides', attributes: { style: `--se-indent:${unit}ch` } })));
  return d;
}

function buildGuides(view: EditorView): DecorationSet {
  const unit = Math.max(1, Math.min(8, getIndentUnit(view.state)));
  const tab = view.state.tabSize;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const ws = /^[ \t]+/.exec(line.text)?.[0];
      if (ws && ws.length < line.text.length) {
        let cols = 0;
        for (const ch of ws) cols = ch === '\t' ? cols + tab - (cols % tab) : cols + 1;
        if (cols >= unit) out.push(guideDeco(Math.floor(cols / unit), ws.includes('\t') ? tab : unit).range(line.from, line.from + ws.length));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out);
}

/** Cheap indentation markers: a repeating 1px gradient over each line's leading whitespace. */
export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildGuides(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildGuides(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Indentation unit guessed from the file (tabs vs 2/4 spaces). */
export function detectIndent(text: string): string {
  let tabs = 0;
  const counts = new Map<number, number>();
  let prev = 0;
  let n = 0;
  for (const line of text.slice(0, 200_000).split('\n')) {
    if (++n > 2000) break;
    if (!line.trim()) continue;
    if (line.startsWith('\t')) {
      tabs++;
      continue;
    }
    const w = /^ */.exec(line)![0].length;
    const d = Math.abs(w - prev);
    if (d > 1 && d <= 8) counts.set(d, (counts.get(d) ?? 0) + 1);
    prev = w;
  }
  const spaceLines = [...counts.values()].reduce((a, b) => a + b, 0);
  if (tabs > spaceLines) return '\t';
  let best = 4;
  let bestCount = 0;
  for (const [w, c] of counts) if (c > bestCount || (c === bestCount && w < best)) [best, bestCount] = [w, c];
  return ' '.repeat(bestCount ? best : 4);
}
