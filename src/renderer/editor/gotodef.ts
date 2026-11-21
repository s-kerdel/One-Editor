// Go to definition in code files: Ctrl/Cmd+click, F12 / Shift+F12 (Find usages), and the underline under
// the pointer while Ctrl/Cmd is held (a decoration only: no lookup until the click). Only forwarding lives
// in the editor chunk; the resolver, its picker and Find usages are the lazy chunk ../search/gotodef.
// Multi-cursor is Alt+click (index.ts), so Ctrl/Cmd+click is free in code files. Markdown is untouched.
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorSelection, StateEffect, StateField, type Extension } from '@codemirror/state';
import { docPath } from './host';
import { modKey } from './links';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_KEY = isMac ? 'Meta' : 'Control';

type Impl = typeof import('../search/gotodef');
let impl: Promise<Impl> | null = null;
const load = () =>
  (impl ??= import('../search/gotodef').catch((err) => {
    impl = null; // a failed chunk load may succeed next time
    throw err;
  }));

function request(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  return { path: view.state.facet(docPath), content: view.state.doc.toString(), line: line.number - 1, col: pos - line.from };
}

/** Go to definition of the name at `pos` (default: the cursor). */
export function goToDefinitionAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const req = request(view, pos);
  void load()
    .then((m) => m.goToDefinition(req))
    .catch((err) => console.warn('[goto] failed', err));
  return true;
}

/** Find in files for the name at `pos` (whole word, exact case, this language). */
export function findUsagesAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const req = request(view, pos);
  void load()
    .then((m) => m.findUsages(req))
    .catch((err) => console.warn('[goto] failed', err));
  return true;
}

// ---- the underline while Ctrl / Cmd is held

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'se-def-link' });
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const pointer = ViewPlugin.fromClass(
  class {
    x = -1;
    y = -1;
    shown = '';
    /** While an underline shows: releasing Ctrl anywhere (the editor may not have focus) or leaving the window clears it. */
    private off: (() => void) | null = null;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      // The field dropped the mark (an edit, or a click cleared it): forget it here too.
      if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setLink) && !e.value))) {
        this.shown = '';
        this.watchRelease(false);
      }
    }
    destroy() {
      this.off?.();
    }
    private watchRelease(on: boolean) {
      if (!on) return void (this.off?.(), (this.off = null));
      if (this.off) return;
      const up = (e: KeyboardEvent | FocusEvent) => (e.type === 'blur' || (e as KeyboardEvent).key === MOD_KEY) && this.show(false);
      window.addEventListener('keyup', up, true);
      window.addEventListener('blur', up);
      this.off = () => {
        window.removeEventListener('keyup', up, true);
        window.removeEventListener('blur', up);
      };
    }
    /** Underline the word under the last pointer position (on), or nothing. Dispatches only on change. */
    show(on: boolean) {
      let range: { from: number; to: number } | null = null;
      if (on && this.x >= 0) {
        const pos = this.view.posAtCoords({ x: this.x, y: this.y });
        const w = pos == null ? null : this.view.state.wordAt(pos);
        if (w && w.to > w.from) range = { from: w.from, to: w.to };
      }
      const key = range ? `${range.from}:${range.to}` : '';
      if (key === this.shown) return;
      this.shown = key;
      this.watchRelease(!!range);
      this.view.dispatch({ effects: setLink.of(range) });
    }
  },
  {
    eventHandlers: {
      mousemove(e) {
        this.x = e.clientX;
        this.y = e.clientY;
        if (modKey(e) && !e.altKey && !e.shiftKey) this.show(true);
        else if (this.shown) this.show(false);
      },
      mouseleave() {
        this.x = -1;
        if (this.shown) this.show(false);
      },
      keydown(e) {
        if (e.key === MOD_KEY) this.show(true);
        else if (this.shown) this.show(false);
      },
      keyup(e) {
        if (e.key === MOD_KEY && this.shown) this.show(false);
      },
      blur() {
        if (this.shown) this.show(false);
      },
    },
  },
);

const click = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || !modKey(e) || e.altKey || e.shiftKey) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null || !view.state.wordAt(pos)) return false; // not on a name: a normal click
    e.preventDefault();
    // The caret goes to the click first, so Go back returns here.
    view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select.pointer', effects: setLink.of(null) });
    view.focus();
    return goToDefinitionAt(view, pos);
  },
});

/** Code files only (index.ts codeExtensions). */
export const gotoDefinition: Extension = [
  linkField,
  pointer,
  click,
  keymap.of([
    { key: 'F12', run: (v) => goToDefinitionAt(v), preventDefault: true },
    { key: 'Shift-F12', run: (v) => findUsagesAt(v), preventDefault: true },
  ]),
];
