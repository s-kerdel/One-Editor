// Diff view, "choose what to commit" (lazy diff chunk): a slim bar above each changed block with its
// checkbox (ticked = in the index = goes into the commit). New states arrive as an effect and the widget
// DOM is updated in place, so a toggle never rebuilds the view (focus and scroll stay where they are).
import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { GitHunk } from '@shared/git';

export const setHunkBars = StateEffect.define<readonly GitHunk[]>();

const CHECKED = { staged: 'true', unstaged: 'false', mixed: 'mixed' } as const;

class HunkBar extends WidgetType {
  constructor(
    readonly index: number,
    readonly h: GitHunk,
    readonly toggle: (index: number) => void,
  ) {
    super();
  }

  eq(o: HunkBar) {
    return o.index === this.index && o.h.state === this.h.state && o.h.a0 === this.h.a0 && o.h.a1 === this.h.a1 && o.h.b0 === this.h.b0 && o.h.b1 === this.h.b1;
  }

  toDOM() {
    const bar = document.createElement('div');
    bar.className = 'se-git-hunkbar';
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'se-check';
    box.setAttribute('role', 'checkbox');
    const label = document.createElement('span');
    label.className = 'se-git-hunkbar-label';
    const size = document.createElement('span');
    size.className = 'se-git-hunkbar-size';
    bar.append(box, label, size);
    // The whole bar is the click target; the index is read from the DOM (it survives updateDOM).
    bar.addEventListener('mousedown', (e) => e.preventDefault()); // no editor selection, no focus jump
    bar.addEventListener('click', () => this.toggle(Number(bar.dataset.index)));
    this.sync(bar);
    return bar;
  }

  updateDOM(dom: HTMLElement) {
    this.sync(dom);
    return true;
  }

  private sync(bar: HTMLElement) {
    const { h } = this;
    bar.dataset.index = String(this.index);
    bar.dataset.state = h.state;
    const [box, label, size] = Array.from(bar.children) as HTMLElement[];
    const where = h.b1 > h.b0 ? (h.b1 - h.b0 > 1 ? `lines ${h.b0 + 1}–${h.b1}` : `line ${h.b0 + 1}`) : `the lines removed at line ${h.b0 + 1}`;
    box.setAttribute('aria-checked', CHECKED[h.state]);
    box.setAttribute('aria-label', `Include ${where} in the commit`);
    label.textContent = h.state === 'mixed' ? 'Include in commit (partly staged)' : 'Include in commit';
    size.textContent = `+${h.b1 - h.b0} −${h.a1 - h.a0}`;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 26;
  }
}

/** Above the block's first working-copy line (a pure deletion: where its lines were). */
const at = (doc: Text, line: number) => (line < doc.lines ? doc.line(line + 1).from : doc.length);

function build(doc: Text, hunks: readonly GitHunk[], toggle: (i: number) => void): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  // side -2: above the unified view's deleted-lines widget (side -1) at the same spot.
  hunks.forEach((h, i) => {
    const pos = at(doc, h.b0);
    b.add(pos, pos, Decoration.widget({ widget: new HunkBar(i, h, toggle), block: true, side: -2 }));
  });
  return b.finish();
}

/** The bars for the working-copy editor; later states via `setHunkBars`. */
export function hunkBars(initial: readonly GitHunk[], toggle: (index: number) => void): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state.doc, initial, toggle),
    update(deco, tr) {
      for (const e of tr.effects) if (e.is(setHunkBars)) return build(tr.state.doc, e.value, toggle);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
