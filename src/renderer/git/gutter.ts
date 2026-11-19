// Editor change bars vs HEAD: added / modified bars, a wedge where lines were deleted. Live while typing
// (the buffer is diffed against the HEAD text in the renderer, debounced); a click on a bar opens an
// inline peek with the old lines and "Revert this change" (one undo step).
//
// Wiring (editor module): add `gitGutter({ source, path: (s) => s.facet(docPath) })` to the doc's
// extensions. HEAD content lives in each doc's own EditorState, so tab switches keep it.
import './gutter.css';
import { Compartment, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField, Transaction, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { diffLineArrays, revertChange, splitLines, type Hunk } from './line-diff';
import { gitUi } from './install';
import { conflictMarkers } from './conflicts';

export interface GitGutterSource {
  /** Identity of the HEAD content for `path` (changes on commit/checkout); null = nothing to compare. */
  key(path: string): string | null;
  /** HEAD text for `path` (LF), or null. */
  load(path: string): Promise<string | null>;
  /** Fires when keys may have changed. */
  subscribe(cb: () => void): () => void;
}

export interface GitGutterConfig {
  source: GitGutterSource;
  path: (state: EditorState) => string;
  /** Debounce after an edit, ms (scaled up for big documents). */
  delay?: number;
  /** Add the gutter column only once the doc has a HEAD version (Markdown live view has no gutters
   *  otherwise: untracked notes and plain folders keep their exact layout). */
  whenBase?: boolean;
}

/** Bigger docs: no live gutter (diffing would cost more than it helps). */
const MAX_DOC = 5_000_000;
/** Old lines shown in a peek at most. */
const PEEK_LINES = 400;

// ---- state --------------------------------------------------------------------------------------

interface Base {
  key: string | null;
  lines: string[] | null;
}
interface Hunks {
  hunks: readonly Hunk[];
  markers: RangeSet<GutterMarker>;
  /** The doc changed since `hunks` were computed (markers are mapped, hunks are not). */
  stale: boolean;
}
interface Peek {
  hunk: Hunk;
  deco: DecorationSet;
}

/** Set the HEAD text (null: none) under `key`. */
export const setGitBase = StateEffect.define<{ key: string | null; text: string | null }>();
const setHunks = StateEffect.define<readonly Hunk[]>();
const setPeek = StateEffect.define<Hunk | null>();

const EMPTY_HUNKS: Hunks = { hunks: [], markers: RangeSet.empty, stale: false };

const baseField = StateField.define<Base>({
  create: () => ({ key: null, lines: null }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setGitBase)) return { key: e.value.key, lines: e.value.text === null ? null : splitLines(e.value.text) };
    return v;
  },
});

const hunkField = StateField.define<Hunks>({
  create: () => EMPTY_HUNKS,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setHunks)) return { hunks: e.value, markers: buildMarkers(tr.state.doc, e.value), stale: false };
      if (e.is(setGitBase) && e.value.text === null) return EMPTY_HUNKS;
    }
    if (tr.docChanged && v.hunks.length) return { hunks: v.hunks, markers: v.markers.map(tr.changes), stale: true };
    if (tr.docChanged) return { ...v, stale: true };
    return v;
  },
});

const peekField = StateField.define<Peek | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setPeek)) return e.value ? makePeek(tr.state, e.value) : null;
      if (e.is(setGitBase)) return null;
    }
    return v && tr.docChanged ? null : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v?.deco ?? Decoration.none),
});

// ---- markers ------------------------------------------------------------------------------------

type MarkKind = 'added' | 'modified' | 'deleted' | 'deleted-top';

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: MarkKind) {
    super();
  }
  eq(other: GutterMarker) {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `se-git-bar se-git-${this.kind}`;
    return el;
  }
}
const MARKERS: Record<MarkKind, ChangeMarker> = {
  added: new ChangeMarker('added'),
  modified: new ChangeMarker('modified'),
  deleted: new ChangeMarker('deleted'),
  'deleted-top': new ChangeMarker('deleted-top'),
};

/** Line (0-based) that carries a hunk's marker / peek. */
const anchorLine = (h: Hunk) => (h.kind === 'deleted' ? Math.max(0, h.newStart - 1) : h.newStart + h.newCount - 1);

function buildMarkers(doc: Text, hunks: readonly Hunk[]): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  const last = doc.lines - 1;
  for (const h of hunks) {
    if (h.kind === 'deleted') {
      const ln = Math.min(last, Math.max(0, h.newStart - 1));
      b.add(doc.line(ln + 1).from, doc.line(ln + 1).from, h.newStart === 0 ? MARKERS['deleted-top'] : MARKERS.deleted);
      continue;
    }
    const end = Math.min(last, h.newStart + h.newCount - 1);
    for (let ln = h.newStart; ln <= end; ln++) {
      const from = doc.line(ln + 1).from;
      b.add(from, from, MARKERS[h.kind]);
    }
  }
  return b.finish();
}

function docLines(doc: Text): string[] {
  const out: string[] = [];
  for (const l of doc.iterLines()) out.push(l);
  return out;
}

/** Fresh hunks for the state's doc vs its HEAD text (null: no HEAD text / doc too big). */
export function computeHunks(state: EditorState): Hunk[] | null {
  const base = state.field(baseField, false);
  if (!base?.lines || state.doc.length > MAX_DOC) return null;
  return diffLineArrays(base.lines, docLines(state.doc));
}

const sameHunks = (a: readonly Hunk[], b: readonly Hunk[]) =>
  a.length === b.length && a.every((h, i) => h.kind === b[i].kind && h.newStart === b[i].newStart && h.newCount === b[i].newCount && h.oldStart === b[i].oldStart && h.oldCount === b[i].oldCount);

/** Recompute now and publish if anything changed. */
function refreshHunks(view: EditorView) {
  const fresh = computeHunks(view.state) ?? [];
  const cur = view.state.field(hunkField, false);
  if (!cur || (!cur.stale && sameHunks(cur.hunks, fresh))) return;
  view.dispatch({ effects: setHunks.of(fresh) });
}

const hunkAtLine = (hunks: readonly Hunk[], ln: number) =>
  hunks.find((h) => (h.kind === 'deleted' ? anchorLine(h) === ln : ln >= h.newStart && ln < h.newStart + h.newCount));

// ---- peek ---------------------------------------------------------------------------------------

function makePeek(state: EditorState, hunk: Hunk): Peek | null {
  const base = state.field(baseField, false);
  if (!base?.lines) return null;
  const old = base.lines.slice(hunk.oldStart, hunk.oldStart + hunk.oldCount);
  const top = hunk.kind === 'deleted' && hunk.newStart === 0;
  const line = state.doc.line(Math.min(state.doc.lines, anchorLine(hunk) + 1));
  const widget = new PeekWidget(hunk, old);
  const deco = Decoration.set([Decoration.widget({ widget, block: true, side: top ? -1 : 1 }).range(top ? line.from : line.to)]);
  return { hunk, deco };
}

const LABELS: Record<Hunk['kind'], (h: Hunk) => string> = {
  added: (h) => `${h.newCount} line${h.newCount === 1 ? '' : 's'} added`,
  modified: (h) => `${h.oldCount} line${h.oldCount === 1 ? '' : 's'} changed`,
  deleted: (h) => `${h.oldCount} line${h.oldCount === 1 ? '' : 's'} deleted`,
};

class PeekWidget extends WidgetType {
  constructor(
    readonly hunk: Hunk,
    readonly old: string[],
  ) {
    super();
  }
  eq(o: PeekWidget) {
    return o.hunk.kind === this.hunk.kind && o.hunk.newStart === this.hunk.newStart && o.hunk.oldStart === this.hunk.oldStart && o.old.join('\n') === this.old.join('\n');
  }
  toDOM(view: EditorView) {
    const root = document.createElement('div');
    root.className = `se-git-peek se-git-peek-${this.hunk.kind}`;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Change since the last commit');
    const head = root.appendChild(document.createElement('div'));
    head.className = 'se-git-peek-head';
    const label = head.appendChild(document.createElement('span'));
    label.className = 'se-git-peek-label';
    label.textContent = LABELS[this.hunk.kind](this.hunk);
    const btn = (text: string, title: string, cls: string, run: () => void, disabled = false) => {
      const b = head.appendChild(document.createElement('button'));
      b.type = 'button';
      b.className = `se-git-peek-btn ${cls}`;
      b.textContent = text;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection/focus
      b.addEventListener('click', (e) => {
        e.preventDefault();
        run();
      });
      return b;
    };
    btn('↑', 'Previous change', 'prev', () => movePeek(view, -1));
    btn('↓', 'Next change', 'next', () => movePeek(view, 1));
    btn('Revert this change', 'Put these lines back as they are in the last commit', 'revert', () => revertHunk(view, this.hunk), view.state.readOnly);
    btn('×', 'Close (Esc)', 'close', () => view.dispatch({ effects: setPeek.of(null) }));
    if (this.old.length) {
      const pre = root.appendChild(document.createElement('pre'));
      pre.className = 'se-git-peek-old';
      const shown = this.old.slice(0, PEEK_LINES);
      for (const l of shown) {
        const div = pre.appendChild(document.createElement('div'));
        div.className = 'se-git-peek-line';
        div.textContent = l || '​';
      }
      if (this.old.length > shown.length) {
        const more = pre.appendChild(document.createElement('div'));
        more.className = 'se-git-peek-more';
        more.textContent = `… ${this.old.length - shown.length} more lines`;
      }
    }
    return root;
  }
  ignoreEvent() {
    return true;
  }
}

/** Open (or toggle) the peek for the hunk on 0-based line `ln`. */
function togglePeekAt(view: EditorView, ln: number): boolean {
  const hunks = computeHunks(view.state);
  if (!hunks) return false;
  const h = hunkAtLine(hunks, ln);
  if (!h) return false;
  const open = view.state.field(peekField, false);
  const same = open && open.hunk.newStart === h.newStart && open.hunk.kind === h.kind;
  view.dispatch({ effects: [setHunks.of(hunks), setPeek.of(same ? null : h)] });
  return true;
}

function movePeek(view: EditorView, dir: 1 | -1) {
  const hunks = computeHunks(view.state);
  const open = view.state.field(peekField, false);
  if (!hunks?.length || !open) return;
  const i = hunks.findIndex((h) => h.newStart === open.hunk.newStart && h.kind === open.hunk.kind);
  const next = hunks[(i + dir + hunks.length) % hunks.length];
  const line = view.state.doc.line(Math.min(view.state.doc.lines, anchorLine(next) + 1));
  view.dispatch({ effects: [setHunks.of(hunks), setPeek.of(next), EditorView.scrollIntoView(line.from, { y: 'center' })] });
}

/** Revert one hunk to its HEAD lines: a single, isolated undo step. */
export function revertHunk(view: EditorView, target: Hunk): boolean {
  const base = view.state.field(baseField, false);
  if (!base?.lines || view.state.readOnly) return false;
  const lines = docLines(view.state.doc);
  const hunks = diffLineArrays(base.lines, lines);
  // The doc may have moved on since the peek opened: match by identity, else by position.
  const h =
    hunks.find((x) => x.kind === target.kind && x.oldStart === target.oldStart && x.oldCount === target.oldCount && x.newCount === target.newCount) ??
    hunks.find((x) => x.newStart === target.newStart && x.kind === target.kind);
  if (!h) return false;
  const c = revertChange(lines, base.lines, h);
  view.dispatch({
    changes: c,
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('git.revert')],
    effects: setPeek.of(null),
  });
  refreshHunks(view);
  return true;
}

// ---- commands -----------------------------------------------------------------------------------

function jump(view: EditorView, dir: 1 | -1): boolean {
  const hunks = computeHunks(view.state);
  if (!hunks?.length) return false;
  const cur = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  const starts = hunks.map((h) => (h.kind === 'deleted' ? anchorLine(h) : h.newStart));
  let i = -1;
  if (dir > 0) i = starts.findIndex((s) => s > cur);
  else for (let k = starts.length - 1; k >= 0 && i < 0; k--) if (starts[k] < cur) i = k;
  if (i < 0) i = dir > 0 ? 0 : starts.length - 1; // wrap around
  const line = view.state.doc.line(Math.min(view.state.doc.lines, starts[i] + 1));
  view.dispatch({ selection: { anchor: line.from }, effects: [setHunks.of(hunks), EditorView.scrollIntoView(line.from, { y: 'center' })] });
  return true;
}

/** Move the cursor to the next / previous change (wraps). */
export const nextChange = (view: EditorView) => jump(view, 1);
export const previousChange = (view: EditorView) => jump(view, -1);
/** Open the peek for the change at the cursor. */
export const peekChangeAtCursor = (view: EditorView) => togglePeekAt(view, view.state.doc.lineAt(view.state.selection.main.head).number - 1);
/** Revert the change at the cursor. */
export function revertChangeAtCursor(view: EditorView): boolean {
  const hunks = computeHunks(view.state);
  const h = hunks && hunkAtLine(hunks, view.state.doc.lineAt(view.state.selection.main.head).number - 1);
  return h ? revertHunk(view, h) : false;
}

/** Current hunks (tests, status UI). */
export function gitHunks(state: EditorState): readonly Hunk[] {
  return state.field(hunkField, false)?.hunks ?? [];
}

// ---- extension ----------------------------------------------------------------------------------

function delayFor(doc: Text, base: number) {
  if (doc.length > 1_000_000) return Math.max(base, 1200);
  if (doc.length > 100_000) return Math.max(base, 500);
  return base;
}

export function gitGutter(cfg: GitGutterConfig): Extension {
  const column: Extension = [
    gutter({
      class: 'se-git-gutter',
      markers: (v) => v.state.field(hunkField).markers,
      domEventHandlers: {
        mousedown(view, line, event) {
          if ((event as MouseEvent).button !== 0) return false;
          return togglePeekAt(view, view.state.doc.lineAt(line.from).number - 1);
        },
      },
    }),
    EditorView.editorAttributes.of({ class: 'se-git-on' }),
  ];
  const shown = cfg.whenBase ? new Compartment() : null;
  /** setGitBase, plus showing / hiding the column in whenBase mode. */
  const baseEffects = (state: EditorState, key: string | null, text: string | null): StateEffect<unknown>[] => {
    const fx: StateEffect<unknown>[] = [setGitBase.of({ key, text })];
    const want = text === null ? [] : column;
    if (shown && shown.get(state) !== want) fx.push(shown.reconfigure(want));
    return fx;
  };
  const loader = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      loading: string | null = null;
      dead = false;
      unsub: () => void;
      constructor(readonly view: EditorView) {
        this.unsub = cfg.source.subscribe(() => this.checkBase());
        // Plugins are created inside a view update: no dispatching until it is over.
        queueMicrotask(() => {
          if (this.dead) return;
          this.checkBase();
          if (view.state.field(hunkField).stale) this.schedule(0);
        });
      }
      update(u: ViewUpdate) {
        if (u.startState.field(baseField) !== u.state.field(baseField)) this.schedule(0);
        else if (u.docChanged) this.schedule(delayFor(u.state.doc, cfg.delay ?? 250));
      }
      schedule(ms: number) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.dead) refreshHunks(this.view);
        }, ms);
      }
      checkBase() {
        if (this.dead) return;
        const path = cfg.path(this.view.state);
        const want = path ? cfg.source.key(path) : null;
        const have = this.view.state.field(baseField).key;
        if (want === have || (want !== null && want === this.loading)) return;
        if (want === null) {
          this.loading = null;
          this.view.dispatch({ effects: baseEffects(this.view.state, null, null) });
          return;
        }
        this.loading = want;
        void cfg.source.load(path).then(
          (text) => {
            if (this.dead || this.loading !== want || cfg.path(this.view.state) !== path) return;
            this.loading = null;
            if (cfg.source.key(path) !== want) return this.checkBase(); // HEAD moved meanwhile
            this.view.dispatch({ effects: baseEffects(this.view.state, want, text) });
          },
          () => {
            if (this.loading === want) this.loading = null;
          },
        );
      }
      destroy() {
        this.dead = true;
        if (this.timer) clearTimeout(this.timer);
        this.unsub();
      }
    },
  );
  return [
    baseField,
    hunkField,
    peekField,
    loader,
    shown ? shown.of([]) : column,
    Prec.high(keymap.of([{ key: 'Escape', run: (v) => (v.state.field(peekField, false) ? (v.dispatch({ effects: setPeek.of(null) }), true) : false) }])),
  ];
}

/**
 * Source that follows the app's git store, which arrives with a lazy chunk after the editor: until then
 * every doc simply has no HEAD version; once it is in, subscribers are told to look again.
 */
export const appGitSource: GitGutterSource = {
  key: (p) => gitUi.peek()?.gutter.key(p) ?? null,
  load: (p) => gitUi.peek()?.gutter.load(p) ?? Promise.resolve(null),
  subscribe(cb) {
    let inner = gitUi.peek()?.gutter.subscribe(cb);
    const off = gitUi.subscribe((ui) => {
      inner?.();
      inner = ui?.gutter.subscribe(cb);
      cb();
    });
    return () => {
      off();
      inner?.();
    };
  },
};

/** Everything git in the editor: change bars vs HEAD (+ peek / revert) and conflict-block highlighting. */
export function gitEditor(opts: { path: (state: EditorState) => string; whenBase?: boolean }): Extension {
  return [gitGutter({ source: appGitSource, path: opts.path, whenBase: opts.whenBase }), conflictMarkers];
}
