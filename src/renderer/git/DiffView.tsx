// "Diff with last commit": HEAD vs the working copy (unsaved edits included), unified or side by side.
// The working-copy side can be edited (`editable`): edits go into the file's open document (./diff-edit).
// Compare (`apply`): blocks go either way, towards every side that is a workspace file (`basePath` = the left one).
// Lazy chunk (@codemirror/merge + language grammars): nothing here loads until the first diff opens.
import './diff-view.css';
import './check.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ReadonlySignal } from '@preact/signals';
import type { GitHunk } from '@shared/git';
import { Annotation, ChangeSet, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers, type Command } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { indentUnit } from '@codemirror/language';
import { MergeView, diff, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, unifiedMergeView, updateOriginalDoc, type Change } from '@codemirror/merge';
import { basename, dirname, isMarkdown } from '@shared/paths';
import { addGlobalKeyFilter } from '../app/commands';
import { chromeTheme, syntaxTheme } from '../editor/theme';
import { detectIndent, loadLanguage } from '../editor/code';
import { diffLines, diffStats } from './line-diff';
import { hunksToChanges } from './compare-diff';
import { hunkBars, setHunkBars } from './hunk-bars';
import { applyChange, blockAt, blockLines, SideHistory, workingCopy, type Edit, type WorkingCopy } from './diff-edit';
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
  /** Compare: the left side IS the workspace file `basePath` too: it takes blocks, and text side by side. */
  basePath?: string;
  /** Compare: blocks are applied to the other side, in both directions ("Apply to ‹name›"). */
  apply?: ApplyProps;
  /** A side was edited here (typed in, a block applied); `text()` reads it as it is when called. */
  onEdited?(side: 'a' | 'b', text: () => string): void;
}

export interface ApplyProps {
  /** Short names of the two sides, for the controls. */
  nameA: string;
  nameB: string;
  /** Sides that can take a block: workspace files only (./diff-edit `compareTargets`). */
  toA: boolean;
  toB: boolean;
  /** Why nothing can be applied right now: the controls stay visible, switched off, and say this. */
  off?: string;
}

const COLLAPSE = { margin: 3, minSize: 6 };
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
const REVERT_KEY = isMac ? '⌘F7' : 'Ctrl+F7';
const APPLY_LEFT_KEY = isMac ? '⇧⌘F7' : 'Ctrl+Shift+F7';
const SAVE_KEY = isMac ? '⌘S' : 'Ctrl+S';
const UNDO_KEY = isMac ? '⌘Z' : 'Ctrl+Z';

async function languageFor(path: string): Promise<Extension | null> {
  if (isMarkdown(path)) return (await import('../editor/syntax')).markdownSupportLite();
  return loadLanguage(path);
}

const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-readonly': 'true' })];
/** Marks a change that came from the document (its tab, the disk): not sent back to it. */
const synced = Annotation.define<boolean>();
/** Marks a left-side change of a unified compare made by its own undo / redo (./diff-edit SideHistory). */
const sideStep = Annotation.define<'undo' | 'redo'>();

/** Smallest single edit turning `a` into `b`: keeps the caret and the scroll position on a sync. */
function minimalEdit(a: string, b: string): Edit {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

interface Control {
  /** The side the block goes to. */
  to: 'a' | 'b';
  text: string;
  label: string;
  title: string;
  /** Switched off: shown, says why (the title), does nothing. */
  off?: boolean;
}

/** "Revert" of a git diff, "apply to the other side" of a compare: one small button per direction. */
function blockButton(c: Control, run: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'se-git-revert';
  b.dataset.to = c.to;
  b.textContent = c.text;
  b.title = c.title;
  b.setAttribute('aria-label', c.label);
  if (c.off) b.setAttribute('aria-disabled', 'true'); // not `disabled`: it keeps its tooltip and its place in the tab order
  // The caret stays where it is, and the merge view's own mousedown handler stays out of it.
  b.addEventListener('mousedown', (e) => (e.preventDefault(), e.stopPropagation()));
  b.addEventListener('click', (e) => (e.preventDefault(), c.off || run(e))); // mouse and keyboard (Enter / Space)
  return b;
}

/** What the control towards side `to` says. Without `ap` it is the git diff's "Revert". */
function control(to: 'a' | 'b', ap: ApplyProps | undefined, split: boolean): Control {
  if (!ap) {
    const label = 'Revert this block: put the old lines back';
    return { to, text: split ? '→' : 'Revert', label, title: `${label} (${REVERT_KEY} at the cursor; undo brings your lines back)` };
  }
  const [name, from, side, key] = to === 'a' ? [ap.nameA, ap.nameB, 'left', APPLY_LEFT_KEY] : [ap.nameB, ap.nameA, 'right', REVERT_KEY];
  const label = `Apply this block to ${name} (the ${side} side)`;
  return {
    to,
    text: split ? (to === 'a' ? '←' : '→') : `Apply to ${name}`,
    label,
    title: ap.off ?? `${label}: its lines there become the ones from ${from} (${key} at the cursor; ${UNDO_KEY} takes it back)`,
    off: !!ap.off,
  };
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
  /** The left side's editor, while it has one of its own that takes text (compare, side by side). */
  const navA = useRef<EditorView | null>(null);
  /** The old side's text of the live view (for reverting a block). */
  const oldDoc = useRef<(() => EditorState['doc']) | null>(null);
  const st = p.staging;
  const blocks = st?.hunks.value ?? null;
  const barText = st?.work?.value ?? p.current;
  /** Edited text (debounced); null: still `current`. */
  const [liveText, setLiveText] = useState<string | null>(null);
  const text = liveText ?? p.current;
  /** The left side as edited (compare with an editable left side); null: still `base`. */
  const [liveBase, setLiveBase] = useState<string | null>(null);
  const base = liveBase ?? p.base;
  // Blocks keep their ranges when staged or not: only a new range list rebuilds the editors.
  const rangeKey = blocks ? blocks.map((h) => `${h.a0},${h.a1},${h.b0},${h.b1}`).join(';') : '';
  const changes = useMemo(
    () => p.changes ?? (blocks?.length ? hunksToChanges(p.base, barText, blocks.map((h) => ({ oldStart: h.a0, oldCount: h.a1 - h.a0, newStart: h.b0, newCount: h.b1 - h.b0 }))) : undefined),
    [p.changes, p.base, barText, rangeKey],
  );
  const stats = useMemo(() => {
    if (p.stats && text === p.current && base === p.base) return p.stats;
    if (blocks?.length && text === barText && base === p.base) return blocks.reduce((t, h) => ({ added: t.added + h.b1 - h.b0, removed: t.removed + h.a1 - h.a0 }), { added: 0, removed: 0 });
    return diffStats(diffLines(base, text));
  }, [p.base, p.current, text, base, barText, p.stats, rangeKey]);
  const same = stats.added === 0 && stats.removed === 0;
  // An editable diff keeps its editor when the last block is reverted (undo must still work).
  const [emptyAtOpen] = useState(same);
  const editable = !!p.editable && !emptyAtOpen;
  const baseEditable = !!p.basePath && !emptyAtOpen;
  const empty = editable || baseEditable ? false : same;
  const wc = useMemo(() => (editable ? workingCopy(p.path) : null), [editable, p.path]);
  /** Compare: the left side's file. */
  const wcA = useMemo(() => (baseEditable ? workingCopy(p.basePath!) : null), [baseEditable, p.basePath]);
  const isDirty = () => !!wc?.dirty() || !!wcA?.dirty();
  const [dirty, setDirty] = useState(isDirty);
  // Controls per direction: a git diff reverts towards the working copy, a compare applies either way.
  const ap = p.apply;
  const toA = !!ap && ap.toA && !emptyAtOpen;
  const toB = ap ? ap.toB && !emptyAtOpen : editable;
  /** Bumped to build the editors again from the live text (the chunks no longer match git's blocks). */
  const [epoch, setEpoch] = useState(0);
  const keep = useRef<{ text: string; textA: string; anchor: number; head: number; focus: 'a' | 'b' | null; scroll: number } | null>(null);
  // git's blocks for exactly these two texts; anything else (a text that was edited since, the slices of
  // an incremental update) goes through the merge package's own diff.
  const fixed = useRef<{ a: string; b: string; changes: readonly Change[] } | null>(null);
  fixed.current = changes ? { a: p.base, b: barText, changes } : null;
  /** Applies the block at the cursor to a side (Ctrl+F7: to the right = revert; Ctrl+Shift+F7: to the left). */
  const applyRef = useRef<((to: 'a' | 'b') => void) | null>(null);
  /** Ctrl+Z / Ctrl+Y where no focused editor takes them; false: not handled. */
  const stepRef = useRef<((kind: 'undo' | 'redo') => boolean) | null>(null);
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    if (wc) void wc.save();
    if (wcA?.dirty()) void wcA.save();
  };
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
    const docA = wcA ? (wcA.text() ?? was?.textA ?? p.base) : p.base;
    if (wc && doc !== p.current) setLiveText(doc);
    if (wcA && docA !== p.base) setLiveBase(docA);
    const initial = st && doc === barText ? (st.hunks.peek() ?? []) : [];
    const bars: Extension = st ? hunkBars(initial, (i, line) => st.toggleHunk(i, line)) : [];
    const split = p.layout === 'split';
    /** The left side's own editor (side by side). */
    let viewA: EditorView | null = null;
    const sideHistory = new SideHistory();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      timer = null;
      const v = nav.current;
      if (!v) return;
      setLiveText(v.state.doc.toString());
      if (wcA && oldDoc.current) setLiveBase(oldDoc.current().toString());
    };
    const edited = (which: 'a' | 'b', w: WorkingCopy, edits: Edit[] | null, read: () => string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, 150);
      onEdited.current?.(which, read);
      // Edits made here go to the document; what came from it (`edits` null) is not sent back.
      if (edits) w.push(edits, read);
      setDirty(isDirty());
    };
    /** An editor that IS a workspace file's document. */
    const editing = (which: 'a' | 'b', w: WorkingCopy, text: string, label: string): Extension => [
      history(),
      search({ top: true }),
      EditorState.tabSize.of(4),
      indentUnit.of(detectIndent(text)),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ 'aria-label': `${label}, editable`, 'aria-multiline': 'true' }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const own = u.transactions.some((t) => t.docChanged && !t.annotation(synced));
        const edits: Edit[] = [];
        if (own) u.changes.iterChanges((from, to, _f, _t, ins) => edits.push({ from, to, insert: ins.toString() }));
        edited(which, w, own ? edits : null, () => u.view.state.doc.toString());
        if (own && which === 'b' && !u.transactions.some((t) => t.isUserEvent('undo') || t.isUserEvent('redo'))) sideHistory.clearRedo();
      }),
    ];
    const still = (label: string): Extension => [readOnly, EditorView.contentAttributes.of({ 'aria-label': label })];
    const side: Extension = wc ? editing('b', wc, doc, p.currentLabel) : still(p.currentLabel);
    // Unified: the left text is the view's "original". Blocks applied to it go to its file from here.
    const original: Extension =
      wcA && !split
        ? EditorView.updateListener.of((u) => {
            for (const tr of u.transactions) {
              for (const e of tr.effects) {
                if (!e.is(updateOriginalDoc)) continue;
                const read = () => getOriginalDoc(u.view.state).toString();
                if (tr.annotation(synced)) {
                  sideHistory.clear();
                  edited('a', wcA, null, read);
                  continue;
                }
                const edits: Edit[] = [];
                e.value.changes.iterChanges((from, to, _f, _t, ins) => edits.push({ from, to, insert: ins.toString() }));
                sideHistory.record(tr.annotation(sideStep), e.value.changes.invert(getOriginalDoc(tr.startState)), { undo: undoDepth(tr.state), redo: redoDepth(tr.state) });
                edited('a', wcA, edits, read);
              }
            }
          })
        : [];
    const selection = was && Math.max(was.anchor, was.head) <= doc.length ? { anchor: was.anchor, head: was.head } : undefined;

    /** Makes side `to` of a block the same as the other side. `at`: a position on the right side, the
     *  block's number, or null = the block at the cursor. */
    const apply = (to: 'a' | 'b', at: number | { index: number } | null) => {
      const v = nav.current;
      const target = to === 'a' ? wcA : wc;
      if (!v || !target || !oldDoc.current || ap?.off) return;
      const chunks = getChunks(v.state)?.chunks ?? [];
      const inA = at === null && !!viewA?.hasFocus;
      const c = at === null ? blockAt(chunks, (inA ? viewA! : v).state.selection.main.head, inA ? 'a' : 'b') : typeof at === 'number' ? blockAt(chunks, at) : chunks[at.index];
      if (!c) return;
      const a = oldDoc.current();
      const change = applyChange(c, to, a, v.state.doc);
      const byCursor = typeof at !== 'object' || at === null;
      if (to === 'b') v.dispatch({ changes: change, userEvent: 'revert', scrollIntoView: byCursor });
      else if (viewA) viewA.dispatch({ changes: change, userEvent: 'revert', scrollIntoView: byCursor });
      else v.dispatch({ effects: originalDocChangeEffect(v.state, ChangeSet.of(change, a.length)), userEvent: 'accept' });
      // Side by side each editor has its own undo history: Ctrl+Z belongs to the side that just changed.
      if (viewA && wc && wcA) (to === 'a' ? viewA : v).focus();
    };
    const hidden = () => Object.assign(document.createElement('span'), { hidden: true });
    if (split) {
      const mv = new MergeView({
        a: { doc: docA, extensions: [...common(), wcA ? editing('a', wcA, docA, p.baseLabel) : still(p.baseLabel)] },
        b: { doc, selection, extensions: [...common(), side, bars] },
        parent: el,
        collapseUnchanged: COLLAPSE,
        gutter: true,
        highlightChanges: true,
        diffConfig,
        ...(toA || toB
          ? {
              revertControls: 'a-to-b' as const,
              // One holder per block (the merge view places it), a button per direction inside.
              renderRevertControl: () => {
                const box = document.createElement('div');
                box.className = 'se-git-apply';
                box.addEventListener('mousedown', (e) => (e.preventDefault(), e.stopPropagation()));
                for (const to of ['a', 'b'] as const) if (to === 'a' ? toA : toB) box.append(blockButton(control(to, ap, true), () => apply(to, { index: Number(box.dataset.chunk) })));
                return box;
              },
            }
          : {}),
      });
      views = [mv.a, mv.b];
      nav.current = mv.b;
      viewA = navA.current = wcA ? mv.a : null;
      oldDoc.current = () => mv.a.state.doc;
      scroller = () => mv.dom;
      destroy = () => mv.destroy();
    } else {
      const v = new EditorView({
        parent: el,
        state: EditorState.create({
          doc,
          selection,
          extensions: [
            ...common(),
            side,
            original,
            unifiedMergeView({
              original: docA,
              // Towards the right side ("reject": the old lines come back) and, in a compare, towards the
              // left ("accept": the old text takes these lines). A git diff has only the first: "Revert".
              mergeControls: toA || toB ? (type, action) => ((type === 'accept' ? toA : toB) ? blockButton(control(type === 'accept' ? 'a' : 'b', ap, false), action) : hidden()) : false,
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
    applyRef.current = (to) => apply(to, null);
    stepRef.current = (kind) => {
      const field = document.activeElement;
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) return false; // the find bar
      if (!viewA) {
        // Unified: the left side's steps, in turn with the editor's own history.
        const change = wcA && sideHistory.take(kind, (kind === 'undo' ? undoDepth : redoDepth)(view.state));
        if (change && change.length === getOriginalDoc(view.state).length) {
          view.dispatch({ effects: originalDocChangeEffect(view.state, change), annotations: sideStep.of(kind) });
          return true;
        }
      }
      // A focused editor takes the key itself; otherwise it goes to the side that can be edited.
      if (views.some((v) => v.hasFocus && !v.state.readOnly)) return false;
      const v = wc ? view : viewA;
      return !!v && (kind === 'undo' ? undo : redo)(v);
    };
    const offs: Array<() => void> = [];
    /** The document changed elsewhere (its tab behind the diff, a reload from disk, format on save). */
    const follow = (w: WorkingCopy, cur: () => string, put: (edit: Edit, from: string) => void) =>
      offs.push(
        w.onChange((external) => {
          setDirty(isDirty());
          if (!external) return; // our own edit coming back
          const now = w.text();
          const from = cur();
          if (now !== undefined && now !== from) put(minimalEdit(from, now), from);
        }),
      );
    const fromDoc = [synced.of(true), Transaction.addToHistory.of(false)];
    if (wc) follow(wc, () => view.state.doc.toString(), (changes) => view.dispatch({ changes, annotations: fromDoc }));
    if (wcA) {
      const a = viewA;
      if (a) follow(wcA, () => a.state.doc.toString(), (changes) => a.dispatch({ changes, annotations: fromDoc }));
      else follow(wcA, () => getOriginalDoc(view.state).toString(), (edit, from) => view.dispatch({ effects: originalDocChangeEffect(view.state, ChangeSet.of(edit, from.length)), annotations: fromDoc }));
    }
    if (wc || wcA) {
      setDirty(isDirty());
      // Typing must land here, not in the editor behind the overlay.
      const first = wc ? view : viewA;
      const focus = was ? (was.focus === 'a' ? (viewA ?? first) : was.focus ? first : null) : first;
      focus?.focus();
      if (was?.scroll) requestAnimationFrame(() => alive && (scroller().scrollTop = was.scroll));
    }
    void languageFor(p.path).then((ext) => {
      if (alive && ext) for (const v of views) v.dispatch({ effects: lang.reconfigure(ext) });
    });
    return () => {
      alive = false;
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
      if (wc || wcA) {
        const sel = view.state.selection.main;
        keep.current = { text: view.state.doc.toString(), textA: oldDoc.current!().toString(), anchor: sel.anchor, head: sel.head, focus: viewA?.hasFocus ? 'a' : view.hasFocus ? 'b' : null, scroll: scroller().scrollTop };
      }
      nav.current = navA.current = null;
      oldDoc.current = null;
      applyRef.current = null;
      stepRef.current = null;
      destroy();
    };
  }, [p.layout, p.base, p.path, empty, wc, wcA, wc ? epoch : p.current, wc ? null : changes, toA, toB, ap?.off]);

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
    // Where the caret is: "the block at the cursor" (Ctrl+F7) is then the one just jumped to.
    const v = navA.current?.hasFocus ? navA.current : nav.current;
    if (v) cmd(v);
  };

  useEffect(() => {
    const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
    const isSave = (e: KeyboardEvent) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';
    const stepOf = (e: KeyboardEvent) => (!mod(e) || e.altKey ? null : e.key.toLowerCase() === 'z' ? (e.shiftKey ? 'redo' : 'undo') : e.key.toLowerCase() === 'y' && !e.shiftKey ? 'redo' : null);
    const files = !!wc || !!wcA;
    const onKey = (e: KeyboardEvent) => {
      const v = nav.current;
      const take = () => (e.preventDefault(), e.stopPropagation());
      if (e.key === 'Escape') {
        const bar = (e.target as HTMLElement | null)?.closest?.('.cm-editor');
        const inBar = bar && EditorView.findFromDOM(bar as HTMLElement);
        if (inBar && searchPanelOpen(inBar.state)) return; // the find bar closes first
        take();
        p.onClose();
      } else if (e.key === 'F7' && mod(e)) {
        take();
        applyRef.current?.(e.shiftKey ? 'a' : 'b'); // a side that is no target takes nothing
      } else if (e.key === 'F7' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        take();
        go(e.shiftKey || e.key === 'ArrowUp' ? goToPreviousChunk : goToNextChunk);
      } else if (files && isSave(e)) {
        take();
        saveRef.current();
      } else if (files && stepOf(e)) {
        if (stepRef.current?.(stepOf(e)!)) take();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // Ctrl+S saves the file of this diff, not whatever tab is active behind it.
    const offSave = files ? addGlobalKeyFilter((e) => !isSave(e)) : () => {};
    return () => {
      window.removeEventListener('keydown', onKey, true);
      offSave();
    };
  }, [p.onClose, wc, wcA]);

  const dir = dirname(p.path);
  return (
    <div class="se-git-diff" role="dialog" aria-label={p.title ?? `Changes in ${p.path} since the last commit`} data-layout={p.layout} data-editable={editable ? 'true' : undefined} data-apply={toA || toB ? `${toA ? 'a' : ''}${toB ? 'b' : ''}` : undefined}>
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
          {(editable || baseEditable) && (
            <span
              class="se-git-diff-editable"
              data-testid="git-diff-editable"
              title={
                ap
                  ? `Blocks can be applied to ${[baseEditable && ap.nameA, editable && ap.nameB].filter(Boolean).join(' and ')}${p.layout === 'split' || !baseEditable ? ', and you can type there' : ''}. ${SAVE_KEY} saves, ${UNDO_KEY} takes a step back.`
                  : `You can type in the working copy here. ${SAVE_KEY} saves, ${REVERT_KEY} reverts the block at the cursor.`
              }
            >
              {' '}
              · {editable && baseEditable ? 'both sides editable' : editable ? 'editable' : 'left side editable'}
              {dirty && ' · unsaved edits'}
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
