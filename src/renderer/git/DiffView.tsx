// "Diff with last commit": HEAD vs the working copy (unsaved edits included), unified or side by side.
// Lazy chunk (@codemirror/merge + language grammars): nothing here loads until the first diff opens.
import './diff-view.css';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers, type Command } from '@codemirror/view';
import { MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView, type Change } from '@codemirror/merge';
import { basename, dirname, isMarkdown } from '@shared/paths';
import { chromeTheme, syntaxTheme } from '../editor/theme';
import { loadLanguage } from '../editor/code';
import { diffLines, diffStats } from './line-diff';

export type DiffLayout = 'unified' | 'split';

export interface DiffViewProps {
  path: string;
  /** Text at HEAD (LF). */
  base: string;
  /** Working copy (LF), unsaved edits included. */
  current: string;
  baseLabel: string;
  currentLabel: string;
  layout: DiffLayout;
  onLayout(layout: DiffLayout): void;
  onClose(): void;
  /** Shown when the texts are equal (e.g. "only line endings differ"). */
  sameNote?: string;
  /** Precomputed changes (git's hunks) instead of the merge package's own diff. */
  changes?: readonly Change[];
  /** Line totals for the header when `changes` come from elsewhere. */
  stats?: { added: number; removed: number };
  /** Which diff produced it ("git diff --histogram", "built-in diff"). */
  engine?: string;
  /** Extra header controls (compare: swap, ignore whitespace, copy as patch). */
  tools?: ComponentChildren;
  /** Header title instead of the file name ("Compare text"). */
  title?: string;
}

const COLLAPSE = { margin: 3, minSize: 6 };

async function languageFor(path: string): Promise<Extension | null> {
  if (isMarkdown(path)) return (await import('../editor/syntax')).markdownSupportLite();
  return loadLanguage(path);
}

const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

export function DiffView(p: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const nav = useRef<EditorView | null>(null);
  const stats = useMemo(() => p.stats ?? diffStats(diffLines(p.base, p.current)), [p.base, p.current, p.stats]);
  const same = stats.added === 0 && stats.removed === 0;

  useEffect(() => {
    const el = host.current;
    if (!el || same) return;
    let alive = true;
    const lang = new Compartment();
    // `se-editor`: the editor's token colours (editor.css) are scoped to it.
    const common = (): Extension[] => [lineNumbers(), highlightSpecialChars(), syntaxTheme, chromeTheme, readOnly, lang.of([]), EditorView.editorAttributes.of({ class: 'se-editor' }), EditorView.contentAttributes.of({ 'aria-readonly': 'true' })];
    let views: EditorView[];
    let destroy: () => void;
    const fixed = p.changes;
    const diffConfig = fixed ? { override: () => fixed } : undefined;
    if (p.layout === 'split') {
      const mv = new MergeView({
        a: { doc: p.base, extensions: [...common(), EditorView.contentAttributes.of({ 'aria-label': p.baseLabel })] },
        b: { doc: p.current, extensions: [...common(), EditorView.contentAttributes.of({ 'aria-label': p.currentLabel })] },
        parent: el,
        collapseUnchanged: COLLAPSE,
        gutter: true,
        highlightChanges: true,
        diffConfig,
      });
      views = [mv.a, mv.b];
      nav.current = mv.b;
      destroy = () => mv.destroy();
    } else {
      const v = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: p.current,
          extensions: [...common(), unifiedMergeView({ original: p.base, mergeControls: false, gutter: true, collapseUnchanged: COLLAPSE, syntaxHighlightDeletions: true, diffConfig })],
        }),
      });
      views = [v];
      nav.current = v;
      destroy = () => v.destroy();
    }
    void languageFor(p.path).then((ext) => {
      if (alive && ext) for (const v of views) v.dispatch({ effects: lang.reconfigure(ext) });
    });
    return () => {
      alive = false;
      nav.current = null;
      destroy();
    };
  }, [p.layout, p.base, p.current, p.path, same, p.changes]);

  const go = (cmd: Command) => {
    const v = nav.current;
    if (v) cmd(v);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        p.onClose();
      } else if (e.key === 'F7' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        e.preventDefault();
        e.stopPropagation();
        go(e.shiftKey || e.key === 'ArrowUp' ? goToPreviousChunk : goToNextChunk);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.onClose]);

  const dir = dirname(p.path);
  return (
    <div class="se-git-diff" role="dialog" aria-label={p.title ?? `Changes in ${p.path} since the last commit`} data-layout={p.layout}>
      <header class="se-git-diff-head">
        <div class="se-git-diff-title">
          <span class="se-git-diff-name">{p.title ?? basename(p.path)}</span>
          {dir && !p.title && <span class="se-git-diff-dir">{dir}</span>}
          {!same && (
            <span class="se-git-diff-stats" data-testid="git-diff-stats">
              <span class="se-git-diff-plus">+{stats.added}</span> <span class="se-git-diff-minus">−{stats.removed}</span>
            </span>
          )}
        </div>
        <div class="se-git-diff-sub">
          {p.baseLabel} <span aria-hidden="true">{p.engine ? '↔' : '→'}</span> {p.currentLabel}
          {p.engine && <span class="se-git-diff-engine"> · {p.engine}</span>}
        </div>
        <div class="se-git-diff-actions">
          {p.tools}
          <div class="se-git-diff-seg" role="radiogroup" aria-label="Layout">
            {(['unified', 'split'] as const).map((l) => (
              <button type="button" role="radio" aria-checked={p.layout === l} class={p.layout === l ? 'on' : ''} onClick={() => p.onLayout(l)}>
                {l === 'unified' ? 'Unified' : 'Side by side'}
              </button>
            ))}
          </div>
          <button type="button" class="se-git-diff-btn" title="Previous change (Shift+F7)" aria-label="Previous change" disabled={same} onClick={() => go(goToPreviousChunk)}>
            ↑
          </button>
          <button type="button" class="se-git-diff-btn" title="Next change (F7)" aria-label="Next change" disabled={same} onClick={() => go(goToNextChunk)}>
            ↓
          </button>
          <button type="button" class="se-git-diff-btn" title="Close (Esc)" aria-label="Close" onClick={p.onClose}>
            ×
          </button>
        </div>
      </header>
      {same ? (
        <div class="se-git-diff-empty" data-testid="git-diff-empty">
          <p>{p.engine ? 'No differences.' : 'No changes since the last commit.'}</p>
          {p.sameNote && <p class="se-git-diff-note">{p.sameNote}</p>}
        </div>
      ) : (
        <div class="se-git-diff-body" ref={host} />
      )}
    </div>
  );
}

export default DiffView;
