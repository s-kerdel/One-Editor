// Finish parsing big documents in idle time.
//
// CodeMirror parses only the viewport plus ~100 KB ahead. Jump to the end of a 1 MB note (Ctrl+End,
// a search hit, a link) and every keystroke then spends its 20 ms in-transaction parse budget
// catching up — at typing speed keys queue for 200–500 ms. Parsing the rest in idle slices right
// after open means the tree is complete before the user gets there; afterwards an edit reparses
// incrementally (~3 ms on 1 MB).
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';

/** Below this the viewport + look-ahead already covers (nearly) everything. */
const MIN_DOC = 150_000;
/** Above this a full tree costs more memory than the catch-up costs time. */
const MAX_DOC = 4_000_000;
const SLICE_MS = 8;

const idle: (cb: (d: IdleDeadline) => void) => number =
  typeof requestIdleCallback === 'function' ? (cb) => requestIdleCallback(cb, { timeout: 1000 }) : (cb) => window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => SLICE_MS }), 50);
const cancelIdle: (h: number) => void = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;

export const parseAhead = ViewPlugin.fromClass(
  class {
    private handle: number | null = null;
    constructor(private readonly view: EditorView) {
      this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.schedule();
    }
    private schedule() {
      if (this.handle !== null) return;
      const st = this.view.state;
      const len = st.doc.length;
      if (len < MIN_DOC || len > MAX_DOC || syntaxTreeAvailable(st, len)) return;
      this.handle = idle((d) => this.run(d));
    }
    private run(d: IdleDeadline) {
      this.handle = null;
      const st = this.view.state;
      // Advances the state's own parse (progress is kept between slices and across edits).
      if (ensureSyntaxTree(st, st.doc.length, Math.max(2, Math.min(SLICE_MS, d.timeRemaining())))) return;
      this.schedule();
    }
    destroy() {
      if (this.handle !== null) cancelIdle(this.handle);
      this.handle = null;
    }
  },
);
