// Smart paste chip (lazy chunk, only with Settings → Editor → Smart paste on). After a paste the chip
// offers "Paste as…" options for a few seconds; the plain paste stays unless one is picked. Picking undoes
// the paste and inserts the new text as ONE paste transaction, so a single Ctrl+Z restores the note.
import './smartpaste.css';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { app } from '../app/app';
import { docPath } from '../editor/host';
import { detectPaste, transformSql, type PasteOption } from './smartpaste';

let current: { el: HTMLElement; close(): void } | null = null;

export function dismissPasteChip(): void {
  current?.close();
}

export function showPasteChip(view: EditorView, range: { from: number; to: number }, text: string, o: { vscodeData: string | null; inCode: boolean }): void {
  dismissPasteChip();
  let options = detectPaste(text, { vscodeData: o.vscodeData });
  // Inside a code block nothing gets fenced again; only "replace the secret" makes sense there.
  if (o.inCode) options = options.filter((x) => x.id === 'secret');
  if (!options.length) return;
  const docAfter = view.state.doc;
  const el = document.createElement('div');
  el.className = 'se-paste-chip';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Paste as');
  el.dataset.testid = 'paste-chip';
  const label = document.createElement('span');
  label.className = 'se-paste-chip-label';
  label.textContent = 'Paste as…';
  el.appendChild(label);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    if (current?.el === el) current = null;
  };
  const pick = async (opt: PasteOption) => {
    close();
    if (view.state.doc !== docAfter) return; // edited since: the paste is no longer what is there
    let insert = opt.text ?? '';
    if (opt.id === 'sql') insert = await transformSql(text, (app.settings.value['format.sqlKeywordCase'] as 'upper' | 'lower' | 'preserve') ?? 'upper');
    if (opt.values?.length && app.variables) {
      try {
        const renames = await app.variables.saveValues(view.state.facet(docPath), opt.values);
        insert = insert.replace(/\{\{([\w.-]+)\}\}/g, (m, n: string) => (renames.has(n) ? `{{${renames.get(n)}}}` : m));
      } catch (err) {
        app.toast(String((err as Error)?.message ?? err), 'error');
        return;
      }
    }
    if (view.state.doc !== docAfter) return;
    undo(view);
    // Blocks go on their own lines.
    const block = /^(```|\| )/.test(insert);
    const at = view.state.selection.main;
    const before = view.state.sliceDoc(Math.max(0, at.from - 1), at.from);
    const after = view.state.sliceDoc(at.to, at.to + 1);
    const text2 = block ? `${before && before !== '\n' ? '\n' : ''}${insert}${after && after !== '\n' ? '\n' : ''}` : insert;
    view.dispatch({ ...view.state.replaceSelection(text2), userEvent: 'input.paste', scrollIntoView: true });
    view.focus();
  };
  for (const opt of options.slice(0, 4)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `se-paste-chip-btn${opt.warn ? ' is-warn' : ''}`;
    b.textContent = opt.label;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's focus + selection
    b.addEventListener('click', () => void pick(opt));
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'se-paste-chip-close';
  x.setAttribute('aria-label', 'Keep as pasted');
  x.title = 'Keep as pasted (Esc)';
  x.textContent = '×';
  x.addEventListener('mousedown', (e) => e.preventDefault());
  x.addEventListener('click', close);
  el.appendChild(x);
  document.body.appendChild(el);
  const c = view.coordsAtPos(range.to) ?? view.coordsAtPos(range.from);
  const w = el.offsetWidth;
  const top = c ? c.bottom + 6 : innerHeight / 2;
  el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, c?.left ?? 100))}px`;
  el.style.top = `${top + el.offsetHeight > innerHeight - 8 ? (c?.top ?? top) - el.offsetHeight - 6 : top}px`;
  window.addEventListener('keydown', onKey, true);
  timer = setTimeout(close, 8000);
  current = { el, close };
}
