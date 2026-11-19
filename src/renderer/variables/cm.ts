// {{variables}} in the editor (part of the editor chunk, kept small). Live mode shows each placeholder
// as a chip with its value; source mode / split's source pane stay raw. Everything that needs data —
// parsing, resolution, the vault, dialogs — is in the lazy ./index chunk, which plugs in a provider.
// Chips are inline replace widgets without vertical margins/padding: CodeMirror's height map stays exact.
import { StateEffect, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { basename, normalize } from '@shared/paths';
import { app } from '../app/app';
import { findPathCandidates } from '../terminal/links';
import { pastedText, pasteIsRaw } from '../whitespace/cm';
import { afterBootIdle, lazy } from '../app/lazy';
import { docPath } from '../editor/host';
import type { CodeHeaderVars, VariablesApi, VarsProvider } from './api';

const CHIP_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::([^{}\n]*))?\}\}/g;

let provider: VarsProvider | null = null;
/** Chips / code-block extras / lint rebuild on this (data, env, target or a setting changed). */
export const varsRefresh = StateEffect.define<null>();

type Mod = typeof import('./index');
const mod = lazy<Mod>(() => import('./index'));
let installed = false;
export function loadVariables(): Promise<Mod> {
  return mod.load().then((m) => {
    if (!installed) (installed = true), m.installVariables();
    return m;
  });
}

export function setVarsProvider(p: VarsProvider | null): void {
  provider = p;
  refreshVariables();
}

export function refreshVariables(): void {
  const v = app.editor?.getView?.() as EditorView | undefined;
  if (v?.dispatch) v.dispatch({ effects: varsRefresh.of(null) });
}

// app.variables from the first frame: actions load the chunk on demand, sync hooks answer once it is in.
const stub: VariablesApi = {
  renderHook: (p, o) => mod.peek()?.api.renderHook(p, o) ?? null,
  copyCode: (c, x) => loadVariables().then((m) => m.api.copyCode(c, x)),
  runCode: (c, x) => loadVariables().then((m) => m.api.runCode(c, x)),
  forTargets: (c, x) => loadVariables().then((m) => m.api.forTargets(c, x)),
  hasTargets: (p) => mod.peek()?.api.hasTargets(p) ?? false,
  prepare: (p) => loadVariables().then((m) => m.api.prepare(p)),
  saveValues: (p, v) => loadVariables().then((m) => m.api.saveValues(p, v)),
};
app.variables ??= stub;

// Only workspaces that use variables pay for the chunk: a variables file in the tree, or {{…}} in an open note.
const fileName = () => String(app.settings.value['variables.fileName'] || 'variables.md').toLowerCase();
const needed = () => {
  const name = fileName();
  if (app.files.value.some((f) => basename(f).toLowerCase() === name)) return true;
  const p = app.activePath.value;
  return !!p && /\{\{\s*[A-Za-z_]/.test(app.docs.get(p)?.content ?? '');
};
afterBootIdle(() => {
  if (needed()) return void loadVariables().catch((err) => console.warn('[variables] failed to load', err));
  const offs = [app.events.on('tree:changed', check), app.events.on('active:changed', check), app.events.on('doc:changed', (p) => p === app.activePath.value && check())];
  function check() {
    if (!needed()) return;
    offs.forEach((o) => o());
    void loadVariables().catch((err) => console.warn('[variables] failed to load', err));
  }
});

/** The note's frontmatter text (the provider parses + caches it; it can override variables.md). */
export function frontmatterOf(state: EditorState): string {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 64 * 1024));
  if (!/^---[ \t]*\r?\n/.test(head)) return '';
  const m = /\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(head.slice(3));
  return m ? head.slice(0, 3 + m.index + m[0].length) : '';
}

/** Info string of the fenced block around `pos` ('' = no info), null outside code; undefined = skip (frontmatter). */
function codeContext(state: EditorState, pos: number): string | null | undefined {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Frontmatter') return undefined;
    if (n.name === 'FencedCode') {
      const ci = n.getChild('CodeInfo');
      return ci ? state.sliceDoc(ci.from, ci.to) : '';
    }
  }
  return null;
}

/** Full fence info of the code block containing `pos` (for copy / run with {target=…} attributes). */
export function fenceInfoAt(state: EditorState, pos: number): string {
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode') {
      const ci = n.getChild('CodeInfo');
      return ci ? state.sliceDoc(ci.from, ci.to) : '';
    }
  }
  const line = state.doc.lineAt(pos);
  return pos !== line.from ? fenceInfoAt(state, line.from) : '';
}

// ---- tooltip (one element, positioned under the hovered chip) ----
let tip: HTMLElement | null = null;
function showTip(anchor: HTMLElement, lines: string[]) {
  hideTip();
  tip = document.createElement('div');
  tip.className = 'se-var-tip';
  tip.setAttribute('role', 'tooltip');
  lines.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = i ? 'se-var-tip-src' : 'se-var-tip-val';
    row.textContent = l;
    tip!.appendChild(row);
  });
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(6, Math.min(innerWidth - w - 6, r.left))}px`;
  tip.style.top = r.bottom + 6 + tip.offsetHeight > innerHeight ? `${r.top - tip.offsetHeight - 6}px` : `${r.bottom + 6}px`;
}
function hideTip() {
  tip?.remove();
  tip = null;
}

class ChipWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly view: { text: string; cls: string; tip: string[] },
    readonly ctx: { path: string; fm: string; info: string | null },
  ) {
    super();
  }
  eq(o: ChipWidget) {
    return o.name === this.name && o.view.text === this.view.text && o.view.cls === this.view.cls && o.view.tip.join('\n') === this.view.tip.join('\n') && o.ctx.info === this.ctx.info && o.ctx.fm === this.ctx.fm;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = `se-var se-var-${this.view.cls}`;
    el.textContent = this.view.text;
    el.dataset.var = this.name;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${this.name}: ${this.view.tip[0] ?? ''} — click to edit`);
    const secret = this.view.cls === 'secret';
    let revealed = false;
    const reveal = (on: boolean) => {
      if (!secret || on === revealed) return;
      revealed = on;
      if (!on) return void (el.textContent = this.view.text);
      void provider?.reveal(this.ctx.path, this.ctx.fm, this.ctx.info, this.name).then((v) => {
        if (revealed && v !== null) el.textContent = v;
      });
    };
    const onKey = (e: KeyboardEvent) => reveal(e.altKey && el.matches(':hover'));
    el.addEventListener('mouseenter', (e) => {
      showTip(el, this.view.tip);
      reveal(e.altKey);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
    });
    el.addEventListener('mousemove', (e) => reveal(e.altKey));
    el.addEventListener('mouseleave', () => {
      hideTip();
      reveal(false);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideTip();
      provider?.editChip(el, this.ctx.path, this.ctx.fm, this.ctx.info, this.name);
    });
    return el;
  }
  destroy() {
    hideTip();
  }
  ignoreEvent(e: Event) {
    return e.type !== 'contextmenu';
  }
}

function touches(state: EditorState, from: number, to: number, focused: boolean): boolean {
  if (!focused) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function buildChips(view: EditorView): DecorationSet {
  const p = provider;
  const { state } = view;
  const path = state.facet(docPath);
  if (!p || !p.showValues || p.skipChips(path)) return Decoration.none;
  const fm = frontmatterOf(state);
  const out: Range<Decoration>[] = [];
  const focused = view.hasFocus;
  for (const { from, to } of view.visibleRanges) {
    const text = state.sliceDoc(from, to);
    for (const m of text.matchAll(CHIP_RE)) {
      const a = from + m.index!;
      const b = a + m[0].length;
      if (touches(state, a, b, focused)) continue;
      const info = codeContext(state, a);
      if (info === undefined) continue;
      const v = p.chip(path, fm, info, m[1], m[2]);
      out.push(Decoration.replace({ widget: new ChipWidget(m[1], v, { path, fm, info }) }).range(a, b));
    }
  }
  return Decoration.set(out, true);
}

const chipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = safe(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.effects.some((e) => e.is(varsRefresh)))) this.decorations = safe(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

function safe(view: EditorView): DecorationSet {
  try {
    return buildChips(view);
  } catch (err) {
    console.error('[variables] chips failed', err);
    return Decoration.none;
  }
}

/** Live mode only (added next to livePreview() by the editor). */
export function variableChips(): Extension {
  return chipPlugin;
}

/** variables.md: YAML diagnostics as lint markers (provider dispatches them; both view modes). */
const lintPlugin = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly view: EditorView) {
      this.schedule(0);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(varsRefresh)))) this.schedule(350);
    }
    schedule(ms: number) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const p = provider;
        if (p && p.isVarsFile(this.view.state.facet(docPath))) p.lintView(this.view);
      }, ms);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

// ---- smart paste (Settings → Editor → Smart paste; the detectors + chip are a lazy chunk) ----
let lastPaste: { text: string; vscode: string | null; at: number } | null = null;
const smartPasteOn = () => app.settings.value['editor.smartPaste'] === true;
type PasteUi = typeof import('./smartpaste-ui');
const pasteUi = lazy<PasteUi>(() => import('./smartpaste-ui'));

const smartPaste = [
  EditorView.domEventHandlers({
    paste(e, view) {
      // Ctrl+Shift+V pastes exactly as copied: no chip either.
      if (!smartPasteOn() || pasteIsRaw()) return void (lastPaste = null), false;
      const dt = e.clipboardData;
      // What CodeMirror will insert: the text after the trailing-whitespace trim (../whitespace).
      lastPaste = dt ? { text: pastedText(dt.getData('text/plain'), view.state.facet(docPath)), vscode: dt.getData('vscode-editor-data') || null, at: Date.now() } : null;
      if (lastPaste?.text) void pasteUi.load().catch(() => {}); // warm while CodeMirror inserts
      return false; // the normal paste (paste.ts / CodeMirror) always happens first
    },
  }),
  EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const paste = u.transactions.find((t) => t.isUserEvent('input.paste'));
    const lp = lastPaste;
    if (!paste) return void pasteUi.peek()?.dismissPasteChip();
    if (!lp || Date.now() - lp.at > 1500 || !smartPasteOn()) return;
    lastPaste = null;
    let range: { from: number; to: number; text: string } | null = null;
    let n = 0;
    paste.changes.iterChanges((_fa, _ta, fromB, toB, ins) => {
      n++;
      range = { from: fromB, to: toB, text: ins.toString() };
    });
    const r = range as { from: number; to: number; text: string } | null;
    // Only what was really pasted as plain text (paste.ts converted HTML / images → not ours).
    if (n !== 1 || !r || r.text !== lp.text) return;
    const view = u.view;
    const inCode = codeContext(u.state, r.from) !== null;
    void pasteUi.load().then((m) => m.showPasteChip(view, r, r.text, { vscodeData: lp.vscode, inCode }));
  }),
];

// ---- ```log blocks: file:line references open the file (Ctrl/Cmd+click), like terminal links ----
const LOG_LANG = /^(?:log|stacktrace|traceback|trace|output)$/i;

function workspaceFile(raw: string): string | null {
  const files = app.files.value;
  const root = (app.workspace.value?.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  let p = raw.replace(/\\/g, '/');
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1);
  p = normalize(p.replace(/^\.\//, '').replace(/^\/+/, ''));
  if (!p || p.startsWith('..')) return null;
  if (files.includes(p)) return p;
  const tail = `/${p}`;
  const hits = files.filter((f) => f.endsWith(tail));
  return hits.length === 1 ? hits[0] : null;
}

function buildLogLinks(view: EditorView): DecorationSet {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(n) {
        if (n.name !== 'FencedCode') return;
        const ci = n.node.getChild('CodeInfo');
        if (!ci || !LOG_LANG.test(state.sliceDoc(ci.from, ci.to).trim().split(/[\s{]/)[0])) return false;
        const first = state.doc.lineAt(n.from).number + 1;
        const last = state.doc.lineAt(n.to).number - 1;
        for (let ln = first; ln <= last; ln++) {
          const line = state.doc.line(ln);
          if (line.to < from || line.from > to) continue;
          for (const c of findPathCandidates(line.text)) {
            const file = workspaceFile(c.path);
            if (file) out.push(Decoration.mark({ class: 'se-log-link', attributes: { 'data-file': file, 'data-at': `${c.line ?? 1}:${c.col ?? 1}`, title: `${file}${c.line ? `:${c.line}` : ''} — Ctrl+click to open` } }).range(line.from + c.start, line.from + c.end));
          }
        }
        return false;
      },
    });
  }
  return Decoration.set(out, true);
}

const logLinks = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildLogLinks(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildLogLinks(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>('.se-log-link');
      if (!el || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false;
      e.preventDefault();
      const [line, col] = (el.dataset.at ?? '1:1').split(':').map(Number);
      void app.openFile(el.dataset.file!, { line: Math.max(0, line - 1), col: Math.max(0, col - 1) });
      return true;
    },
  }),
  EditorView.baseTheme({
    '.se-log-link': { textDecoration: 'underline dotted', textUnderlineOffset: '2px' },
    '&.se-mod-down .se-log-link': { cursor: 'pointer', color: 'var(--accent)', textDecorationStyle: 'solid' },
  }),
];

/** Every markdown note: variables.md lint, smart paste, ```log links. */
export function variablesEditor(): Extension {
  return [lintPlugin, smartPaste, logLinks];
}

/** `{{` completion: names defined for this note, with their values as hints. */
export function variableCompletion(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\{\{\s*[\w.-]*$/);
  const p = provider;
  if (!m || !p) return null;
  const at = m.from + /^\{\{\s*/.exec(m.text)![0].length;
  const info = codeContext(ctx.state, ctx.pos);
  if (info === undefined) return null;
  const items = p.completions(ctx.state.facet(docPath), frontmatterOf(ctx.state), info);
  if (!items.length) return null;
  return {
    from: at,
    options: items.map((o) => ({
      label: o.label,
      detail: o.detail,
      info: o.info,
      boost: o.boost,
      type: 'variable',
      apply: (view: EditorView, _c: unknown, a: number, b: number) => {
        // closeBrackets usually typed the `}}` already: step over it instead of doubling it.
        const after = /^\s*\}\}/.exec(view.state.sliceDoc(b, b + 4));
        view.dispatch({ changes: { from: a, to: b, insert: after ? o.label : `${o.label}}}` }, selection: { anchor: a + o.label.length + (after ? after[0].length : 2) } });
      },
    })),
    validFor: /^[\w.-]*$/,
  };
}

/** Code-block header extras (OS hint, multi-target button) for live.ts's header widget — only for
 *  blocks that use variables or pick a target, so unrelated code stays quiet. */
export function codeHeaderVars(state: EditorState, info: string, from: number, to: number): CodeHeaderVars | null {
  const p = provider;
  if (!p || p.skipChips(state.facet(docPath))) return null;
  if (!/\{target=/.test(info) && !/\{\{\s*[A-Za-z_]/.test(state.sliceDoc(from, Math.min(to, from + 20_000)))) return null;
  try {
    return p.codeHeader(state.facet(docPath), frontmatterOf(state), info);
  } catch {
    return null;
  }
}

/** Code + context of the fenced block at the cursor of the active editor (palette command). */
export function codeAtCursor(): { code: string; ctx: { path: string; info: string } } | null {
  const view = app.editor?.getView?.() as EditorView | undefined;
  if (!view?.state) return null;
  const { state } = view;
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(state.selection.main.head, 1); n; n = n.parent) {
    if (n.name !== 'FencedCode') continue;
    const first = state.doc.lineAt(n.from);
    const last = state.doc.lineAt(n.to);
    const closed = n.getChildren('CodeMark').length >= 2 && last.number > first.number;
    const end = closed ? last.number - 1 : last.number;
    const code = end > first.number ? state.sliceDoc(state.doc.line(first.number + 1).from, state.doc.line(end).to) : '';
    const ci = n.getChild('CodeInfo');
    return { code, ctx: { path: state.facet(docPath), info: ci ? state.sliceDoc(ci.from, ci.to) : '' } };
  }
  return null;
}

/** Copy / run a code block with its placeholders resolved (falls back to the raw text when nothing to resolve). */
export async function codeAction(kind: 'copy' | 'run', view: EditorView, pos: number, code: string): Promise<boolean | null> {
  if (!/\{\{\s*[A-Za-z_]/.test(code) || !app.variables) return null;
  const ctx = { path: view.state.facet(docPath), info: fenceInfoAt(view.state, pos) };
  return kind === 'copy' ? app.variables.copyCode(code, ctx) : app.variables.runCode(code, ctx);
}
