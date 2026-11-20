// "Diff with last commit": HEAD vs the working copy (unsaved edits included), unified or side by side.
// The working-copy side can be edited (`editable`): edits go into the file's open document (./diff-edit).
// Lazy chunk (@codemirror/merge + language grammars): nothing here loads until the first diff opens.
import './diff-view.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import type { GitHunk } from '@shared/git';
import { Annotation, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers, type Command } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { indentUnit } from '@codemirror/language';
import { MergeView, diff, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, unifiedMergeView, type Change } from '@codemirror/merge';
import { basename, dirname, isMarkdown } from '@shared/paths';
import { addGlobalKeyFilter } from '../app/commands';
import { chromeTheme, syntaxTheme } from '../editor/theme';
import { detectIndent, loadLanguage } from '../editor/code';
import { diffLines, diffStats } from './line-diff';
import { hunksToChanges } from './compare-diff';
import { hunkBars, setHunkBars } from './hunk-bars';
import { blockAt, blockLines, revertChange, workingCopy, type Edit } from './diff-edit';
import type { Check } from './selection';

export type DiffLayout = 'unified' | 'split';

/** Opened from the Source control pane: what goes into the commit, for the file and per block. */
export interface StagingProps {
  /** Blocks of base → current with their staged state; null: the whole file only (`note` says why). */
  hunks: ReadonlySignal<readonly GitHunk[] | null>;
  /** The working-copy text the blocks' lines refer to (default: `current`). It moves on when the diff
   *  is edited and saved: the view keeps its editors and only the bars follow. */
  work?: ReadonlySignal<string>;
  /** The file's own box; null: none (e.g. resolved away meanwhile). */
  file: ReadonlySignal<Check | null>;
  busy: ReadonlySignal<boolean>;
  note?: string;
  /** `line`: where the block's bar is now (0-based working-copy line), for a click on an edited diff. */
  toggleHunk(index: number, line?: () => number): void;
  toggleFile(): void;
}

const ARIA: Record<Check, 'true' | 'false' | 'mixed'> = { on: 'true', off: 'false', mixed: 'mixed' };

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
  staging?: StagingProps;
  /** `current` IS the workspace file `path` (./diff-edit `editableSide`): it can be edited here and
   *  blocks reverted. Everything else (HEAD, the index, old commits, the clipboard) stays read-only. */
  editable?: boolean;
  /** Editable only: the working copy was edited here; `text()` reads it as it is when called. */
  onEdited?(text: () => string): void;
}

const COLLAPSE = { margin: 3, minSize: 6 };
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
const REVERT_KEY = isMac ? '⌘F7' : 'Ctrl+F7';
const SAVE_KEY = isMac ? '⌘S' : 'Ctrl+S';

async function languageFor(path: string): Promise<Extension | null> {
  if (isMarkdown(path)) return (await import('../editor/syntax')).markdownSupportLite();
  return loadLanguage(path);
}

const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-readonly': 'true' })];
/** Marks a change that came from the document (its tab, the disk): not sent back to it. */
const synced = Annotation.define<boolean>();

/** Smallest single edit turning `a` into `b`: keeps the caret and the scroll position on a sync. */
function minimalEdit(a: string, b: string): Edit {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

function revertButton(text: string, run: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'se-git-revert';
  b.textContent = text;
  const label = 'Revert this block: put the old lines back';
  b.title = `${label} (${REVERT_KEY} at the cursor; undo brings your lines back)`;
  b.setAttribute('aria-label', label);
  // The caret stays where it is, and the merge view's own mousedown handler stays out of it.
  b.addEventListener('mousedown', (e) => (e.preventDefault(), e.stopPropagation()));
  b.addEventListener('click', (e) => (e.preventDefault(), run(e))); // mouse and keyboard (Enter / Space)
  return b;
}

/** Do the view's chunks cover the same lines as git's blocks? (Blocks one blank line apart share a chunk.) */
function aligned(v: EditorView, hunks: readonly GitHunk[]): boolean {
  const chunks = getChunks(v.state)?.chunks;
  if (!chunks) return true;
  let i = 0;
  for (const c of chunks) {
    const [b0, b1] = blockLines(c, v.state.doc);
    if (hunks[i]?.b0 !== b0) return false;
    while (i < hunks.length && hunks[i].b1 < b1) i++;
    if (hunks[i]?.b1 !== b1) return false;
    i++;
  }
  return i === hunks.length;
}

export function DiffView(p: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const nav = useRef<EditorView | null>(null);
  /** The old side's text of the live view (for reverting a block). */
  const oldDoc = useRef<(() => EditorState['doc']) | null>(null);
  const st = p.staging;
  const blocks = st?.hunks.value ?? null;
  const barText = st?.work?.value ?? p.current;
  /** Edited text (debounced); null: still `current`. */
  const [liveText, setLiveText] = useState<string | null>(null);
  const text = liveText ?? p.current;
  // Blocks keep their ranges when staged or not: only a new range list rebuilds the editors.
  const rangeKey = blocks ? blocks.map((h) => `${h.a0},${h.a1},${h.b0},${h.b1}`).join(';') : '';
  const changes = useMemo(
    () => p.changes ?? (blocks?.length ? hunksToChanges(p.base, barText, blocks.map((h) => ({ oldStart: h.a0, oldCount: h.a1 - h.a0, newStart: h.b0, newCount: h.b1 - h.b0 }))) : undefined),
    [p.changes, p.base, barText, rangeKey],
  );
  const stats = useMemo(() => {
    if (p.stats && text === p.current) return p.stats;
    if (blocks?.length && text === barText) return blocks.reduce((t, h) => ({ added: t.added + h.b1 - h.b0, removed: t.removed + h.a1 - h.a0 }), { added: 0, removed: 0 });
    return diffStats(diffLines(p.base, text));
  }, [p.base, p.current, text, barText, p.stats, rangeKey]);
  const same = stats.added === 0 && stats.removed === 0;
  // An editable diff keeps its editor when the last block is reverted (undo must still work).
  const [emptyAtOpen] = useState(same);
  const editable = !!p.editable && !emptyAtOpen;
  const empty = editable ? false : same;
  const wc = useMemo(() => (editable ? workingCopy(p.path) : null), [editable, p.path]);
  const [dirty, setDirty] = useState(() => !!wc?.dirty());
  /** Bumped to build the editors again from the live text (the chunks no longer match git's blocks). */
  const [epoch, setEpoch] = useState(0);
  const keep = useRef<{ text: string; anchor: number; head: number; focus: boolean; scroll: number } | null>(null);
  // git's blocks for exactly these two texts; anything else (a text that was edited since, the slices of
  // an incremental update) goes through the merge package's own diff.
  const fixed = useRef<{ a: string; b: string; changes: readonly Change[] } | null>(null);
  fixed.current = changes ? { a: p.base, b: barText, changes } : null;
  /** Reverts the block at the cursor (Ctrl+F7). */
  const revertRef = useRef<(() => void) | null>(null);
  const onEdited = useRef(p.onEdited);
  onEdited.current = p.onEdited;

  useEffect(() => {
    const el = host.current;
    if (!el || empty) return;
    let alive = true;
    const lang = new Compartment();
    // `se-editor`: the editor's token colours (editor.css) are scoped to it.
    const common = (): Extension[] => [lineNumbers(), highlightSpecialChars(), syntaxTheme, chromeTheme, lang.of([]), EditorView.editorAttributes.of({ class: 'se-editor' })];
    let views: EditorView[];
    let destroy: () => void;
    let scroller: () => HTMLElement;
    const diffConfig = {
      scanLimit: 500,
      override: (a: string, b: string) => {
        const f = fixed.current;
        return f && a === f.a && b === f.b ? f.changes : diff(a, b, { scanLimit: 500 });
      },
    };
    const was = keep.current;
    keep.current = null;
    const doc = wc ? (wc.text() ?? was?.text ?? p.current) : p.current;
    if (wc && doc !== p.current) setLiveText(doc);
    const initial = st && doc === barText ? (st.hunks.peek() ?? []) : [];
    const bars: Extension = st ? hunkBars(initial, (i, line) => st.toggleHunk(i, line)) : [];

    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      timer = null;
      const t = nav.current?.state.doc.toString();
      if (t === undefined) return;
      setLiveText(t);
    };
    const side: Extension = wc
      ? [
          history(),
          search({ top: true }),
          EditorState.tabSize.of(4),
          indentUnit.of(detectIndent(doc)),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ 'aria-label': `${p.currentLabel}, editable`, 'aria-multiline': 'true' }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(report, 150);
            onEdited.current?.(() => u.view.state.doc.toString());
            // Edits made here go to the document; what came from it is not sent back.
            if (!u.transactions.some((t) => t.docChanged && !t.annotation(synced))) return;
            const edits: Edit[] = [];
            u.changes.iterChanges((from, to, _f, _t, ins) => edits.push({ from, to, insert: ins.toString() }));
            wc.push(edits, () => u.view.state.doc.toString());
            setDirty(wc.dirty());
          }),
        ]
      : [readOnly, EditorView.contentAttributes.of({ 'aria-label': p.currentLabel })];
    const selection = was && Math.max(was.anchor, was.head) <= doc.length ? { anchor: was.anchor, head: was.head } : undefined;

    const revert = (v: EditorView, at: number | { index: number }) => {
      const chunks = getChunks(v.state)?.chunks ?? [];
      const c = typeof at === 'number' ? blockAt(chunks, at) : chunks[at.index];
      if (c && oldDoc.current) v.dispatch({ changes: revertChange(c, oldDoc.current(), v.state.doc), userEvent: 'revert', scrollIntoView: typeof at === 'number' });
    };
    if (p.layout === 'split') {
      const mv = new MergeView({
        a: { doc: p.base, extensions: [...common(), readOnly, EditorView.contentAttributes.of({ 'aria-label': p.baseLabel })] },
        b: { doc, selection, extensions: [...common(), side, bars] },
        parent: el,
        collapseUnchanged: COLLAPSE,
        gutter: true,
        highlightChanges: true,
        diffConfig,
        ...(wc
          ? {
              revertControls: 'a-to-b' as const,
              renderRevertControl: () => {
                const b = revertButton('→', () => revert(mv.b, { index: Number(b.dataset.chunk) }));
                return b;
              },
            }
          : {}),
      });
      views = [mv.a, mv.b];
      nav.current = mv.b;
      oldDoc.current = () => mv.a.state.doc;
      scroller = () => mv.dom;
      destroy = () => mv.destroy();
    } else {
      const hidden = () => Object.assign(document.createElement('span'), { hidden: true });
      const v = new EditorView({
        parent: el,
        state: EditorState.create({
          doc,
          selection,
          extensions: [
            ...common(),
            side,
            unifiedMergeView({
              original: p.base,
              // Only "revert": there is nothing to accept, the right side already is the working copy.
              mergeControls: wc ? (type, action) => (type === 'reject' ? revertButton('Revert', action) : hidden()) : false,
              gutter: true,
              collapseUnchanged: COLLAPSE,
              syntaxHighlightDeletions: true,
              diffConfig,
            }),
            bars,
          ],
        }),
      });
      views = [v];
      nav.current = v;
      oldDoc.current = () => getOriginalDoc(v.state);
      scroller = () => v.scrollDOM;
      destroy = () => v.destroy();
    }
    const view = nav.current;
    revertRef.current = () => revert(view, view.state.selection.main.head);
    let off = () => {};
    if (wc) {
      // The document changed elsewhere (its tab behind the diff, a reload from disk, format on save).
      off = wc.onChange((external) => {
        setDirty(wc.dirty());
        if (!external) return; // our own edit coming back
        const now = wc.text();
        const cur = view.state.doc.toString();
        if (now !== undefined && now !== cur) view.dispatch({ changes: minimalEdit(cur, now), annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
      });
      setDirty(wc.dirty());
      // Typing must land here, not in the editor behind the overlay.
      if (!was || was.focus) view.focus();
      if (was?.scroll) requestAnimationFrame(() => alive && (scroller().scrollTop = was.scroll));
    }
    void languageFor(p.path).then((ext) => {
      if (alive && ext) for (const v of views) v.dispatch({ effects: lang.reconfigure(ext) });
    });
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
      if (wc) {
        const sel = view.state.selection.main;
        keep.current = { text: view.state.doc.toString(), anchor: sel.anchor, head: sel.head, focus: view.hasFocus, scroll: scroller().scrollTop };
      }
      nav.current = null;
      oldDoc.current = null;
      revertRef.current = null;
      destroy();
    };
  }, [p.layout, p.base, p.path, empty, wc, wc ? epoch : p.current, wc ? null : changes]);

  const realigned = useRef('');

  // New staged states (a toggle, a refresh, a save of the edited diff): into the bars as they are.
  useEffect(() => {
    const v = nav.current;
    if (!v || !st) return;
    const list = blocks ?? [];
    if (!wc) return void (list.length && v.dispatch({ effects: setHunkBars.of(list) }));
    if (v.state.doc.toString() !== barText) return; // edited since: the bars stay with their lines until the save
    // Typing re-diffs only around the edit, which now and then splits lines differently from git: one
    // rebuild from git's blocks puts bars and colours back on the same lines.
    const key = `${rangeKey}|${barText.length}`;
    if (list.length && realigned.current !== key && !aligned(v, list)) {
      realigned.current = key;
      return setEpoch((n) => n + 1);
    }
    v.dispatch({ effects: setHunkBars.of(list) });
  }, [blocks, barText]);

  const go = (cmd: Command) => {
    const v = nav.current;
    if (v) cmd(v);
  };

  useEffect(() => {
    const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
    const isSave = (e: KeyboardEvent) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';
    const onKey = (e: KeyboardEvent) => {
      const v = nav.current;
      const take = () => (e.preventDefault(), e.stopPropagation());
      if (e.key === 'Escape') {
        if (v && searchPanelOpen(v.state) && v.dom.contains(document.activeElement)) return; // the find bar closes first
        take();
        p.onClose();
      } else if (e.key === 'F7' && mod(e)) {
        take();
        revertRef.current?.();
      } else if (e.key === 'F7' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        take();
        go(e.shiftKey || e.key === 'ArrowUp' ? goToPreviousChunk : goToNextChunk);
      } else if (wc && isSave(e)) {
        take();
        void wc.save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // Ctrl+S saves the file of this diff, not whatever tab is active behind it.
    const offSave = wc ? addGlobalKeyFilter((e) => !isSave(e)) : () => {};
    return () => {
      window.removeEventListener('keydown', onKey, true);
      offSave();
    };
  }, [p.onClose, wc]);

  const dir = dirname(p.path);
  return (
    <div class="se-git-diff" role="dialog" aria-label={p.title ?? `Changes in ${p.path} since the last commit`} data-layout={p.layout} data-editable={editable ? 'true' : undefined}>
      <header class="se-git-diff-head">
        <div class="se-git-diff-title">
          <span class="se-git-diff-name">{p.title ?? basename(p.path)}</span>
          {dir && !p.title && <span class="se-git-diff-dir">{dir}</span>}
          {!empty && (
            <span class="se-git-diff-stats" data-testid="git-diff-stats">
              <span class="se-git-diff-plus">+{stats.added}</span> <span class="se-git-diff-minus">−{stats.removed}</span>
            </span>
          )}
        </div>
        <div class="se-git-diff-sub">
          {p.baseLabel} <span aria-hidden="true">{p.engine ? '↔' : '→'}</span> {p.currentLabel}
          {editable && (
            <span class="se-git-diff-editable" data-testid="git-diff-editable" title={`You can type in the working copy here. ${SAVE_KEY} saves, ${REVERT_KEY} reverts the block at the cursor.`}>
              {' '}
              · editable{dirty && ' · unsaved edits'}
            </span>
          )}
          {p.engine && <span class="se-git-diff-engine"> · {p.engine}</span>}
          {st?.busy.value ? <span class="se-git-diff-engine"> · Staging…</span> : st?.note && !blocks?.length && <span class="se-git-diff-engine"> · {st.note}</span>}
        </div>
        <div class="se-git-diff-actions">
          {p.tools}
          {st?.file.value && (
            <button
              type="button"
              class="se-git-diff-tool se-git-diff-include"
              role="checkbox"
              aria-checked={ARIA[st.file.value]}
              title={blocks?.length ? 'The whole file in or out of the commit (or tick single blocks below)' : 'Put this file into the commit, or leave it out'}
              onClick={() => st.toggleFile()}
            >
              <span class="se-check" aria-hidden="true" data-checked={ARIA[st.file.value]} /> Include in commit
            </button>
          )}
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
      {empty ? (
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
