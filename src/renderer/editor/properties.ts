// Obsidian-style properties editor for YAML frontmatter (live preview). Rendered as a block widget by
// live.ts when the cursor isn't inside the frontmatter; every edit rewrites only the touched
// property's lines (see frontmatter.ts) through a normal transaction, so undo works.
import { EditorSelection } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { app } from '../app/app';
import { bodyReplacement, coerce, frontmatterBody, parseProps, removeProp, renameProp, setProp, typeForNewKey, type Prop, type PropType, type PropValue } from './frontmatter';
import { icon } from './widgets';
import { renderInline } from './inline-render';
import { followLinkElement } from './links';

const TYPE_ICON: Record<PropType, string> = {
  text: 'text',
  empty: 'text',
  number: 'hash',
  checkbox: 'checkbox',
  date: 'calendar',
  datetime: 'calendar-clock',
  list: 'list',
  tags: 'tags',
  complex: 'braces',
};

type Focus = { key: string | null; part: 'value' | 'key' | 'add' | 'list' };
/** Focus to restore after the widget is rebuilt by our own edit (DOM is recreated on change). */
let pendingFocus: Focus | null = null;

function region(view: EditorView) {
  return frontmatterBody(view.state.sliceDoc(0, Math.min(view.state.doc.length, 256 * 1024)));
}

/** Applies `mutate` to the frontmatter body. Returns false when nothing changed. */
function edit(view: EditorView, mutate: (body: string) => string, focus: Focus | null = null): boolean {
  const fm = region(view);
  if (!fm) return false;
  const next = mutate(fm.body);
  pendingFocus = focus;
  if (next === fm.body) {
    restoreFocus(view);
    return false;
  }
  view.dispatch({ changes: { from: fm.from, to: fm.to, insert: bodyReplacement(next) }, userEvent: 'input.props' });
  restoreFocus(view);
  return true;
}

/** Focuses the pending field in the (new) widget. CodeMirror builds widget DOM synchronously during
 *  dispatch, so this normally succeeds right after it; a frame later is the fallback. */
function restoreFocus(view: EditorView) {
  const run = () => {
    const f = pendingFocus;
    if (!f) return true;
    const root = view.dom.querySelector<HTMLElement & { __seFocus?: (f: Focus) => void }>('.se-props');
    if (!root?.__seFocus) return false;
    pendingFocus = null;
    root.__seFocus(f);
    return true;
  };
  if (!run()) requestAnimationFrame(() => void (run() || (pendingFocus = null)));
}

/** Ensures a frontmatter block exists and starts the "add property" flow (slash menu → Properties). */
export function openPropertiesEditor(view: EditorView) {
  pendingFocus = { key: null, part: 'add' };
  if (!region(view)) {
    const head = view.state.selection.main.head;
    const insert = '---\n---\n';
    view.dispatch({ changes: { from: 0, insert }, selection: EditorSelection.cursor(head + insert.length), userEvent: 'input.props', scrollIntoView: true });
  }
  view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
  restoreFocus(view);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Text input that commits on Enter/blur and cancels on Escape. */
function inlineInput(value: string, opts: { placeholder?: string; type?: string; onCommit: (v: string, how: 'enter' | 'tab' | 'shift-tab' | 'blur') => void; onCancel: () => void }) {
  const input = el('input', 'se-prop-input');
  input.type = opts.type ?? 'text';
  input.value = value;
  input.spellcheck = false;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  let done = false;
  const finish = (how: 'enter' | 'tab' | 'shift-tab' | 'blur' | 'cancel') => {
    if (done) return;
    done = true;
    if (how === 'cancel') opts.onCancel();
    else opts.onCommit(input.value, how);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish('enter');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish('cancel');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      finish(e.shiftKey ? 'shift-tab' : 'tab');
    }
  });
  input.addEventListener('blur', () => finish('blur'));
  return input;
}

function dateValue(p: Prop): string {
  return typeof p.value === 'string' ? (p.type === 'datetime' ? p.value.replace(' ', 'T').slice(0, 16) : p.value) : '';
}

export class PropertiesWidget extends WidgetType {
  constructor(readonly body: string) {
    super();
  }
  eq(o: PropertiesWidget) {
    return o.body === this.body;
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 46 + parseProps(this.body).props.length * 32;
  }

  toDOM(view: EditorView) {
    // Spacing lives in the outer block's padding: CodeMirror measures block widgets without their
    // margins, so a margin here desyncs the height map (clicks below would land a line too low).
    const block = el('div', 'se-props-block');
    const root = el('div', 'se-props') as HTMLElement & { __seFocus?: (f: Focus) => void };
    block.appendChild(root);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Properties');
    const { props } = parseProps(this.body);

    const head = el('div', 'se-props-head');
    const title = el('span', 'se-props-title');
    title.append(icon('sliders'), document.createTextNode('Properties'));
    const count = el('span', 'se-props-count', props.length ? String(props.length) : '');
    const src = el('button', 'se-props-btn');
    src.type = 'button';
    src.title = 'Edit as YAML';
    src.setAttribute('aria-label', 'Edit as YAML');
    src.appendChild(icon('braces'));
    src.addEventListener('click', () => revealYaml(view));
    head.append(title, count, el('span', 'se-props-spacer'), src);
    root.appendChild(head);

    const rows = el('div', 'se-props-rows');
    const rowEls = new Map<string, HTMLElement>();
    const order = props.map((p) => p.key);
    const focusNext = (key: string, dir: 1 | -1) => {
      const i = order.indexOf(key) + dir;
      if (i >= 0 && i < order.length) pendingFocus = { key: order[i], part: 'value' };
      else if (dir === 1) pendingFocus = { key: null, part: 'add' };
    };

    for (const p of props) {
      const row = el('div', `se-prop se-prop-t-${p.type}`);
      row.dataset.key = p.key;
      const keyBtn = el('button', 'se-prop-key');
      keyBtn.type = 'button';
      keyBtn.title = `${p.key} (${p.type === 'empty' ? 'text' : p.type}) — click to rename`;
      keyBtn.append(icon(TYPE_ICON[p.type]), el('span', 'se-prop-key-text', p.key));
      const val = el('div', 'se-prop-value');
      const del = el('button', 'se-prop-del');
      del.type = 'button';
      del.title = 'Remove property';
      del.setAttribute('aria-label', `Remove ${p.key}`);
      del.appendChild(icon('x'));
      del.addEventListener('click', () => edit(view, (b) => removeProp(b, p.key)));

      const renameStart = () => {
        const input: HTMLInputElement = inlineInput(p.key, {
          onCommit: (v, how) => {
            const next = v.trim();
            if (!next || (next !== p.key && order.includes(next))) return void input.replaceWith(keyBtn);
            if (next === p.key) return void input.replaceWith(keyBtn);
            edit(view, (b) => renameProp(b, p.key, next), how === 'blur' ? null : { key: next, part: 'value' });
          },
          onCancel: () => input.replaceWith(keyBtn),
        });
        input.classList.add('se-prop-key-input');
        keyBtn.replaceWith(input);
        input.focus();
        input.select();
      };
      keyBtn.addEventListener('click', renameStart);

      const commitValue = (value: PropValue, how: 'enter' | 'tab' | 'shift-tab' | 'blur', type?: PropType) => {
        if (how === 'tab') focusNext(p.key, 1);
        else if (how === 'shift-tab') focusNext(p.key, -1);
        const focus = how === 'tab' || how === 'shift-tab' ? pendingFocus : null;
        edit(view, (b) => setProp(b, p.key, value, { type: type ?? p.type }), focus);
        if (how === 'enter') view.focus();
      };

      const startText = () => {
        const shown = p.value === null ? '' : String(p.value);
        const input = inlineInput(shown, {
          placeholder: 'Empty',
          onCommit: (v, how) => {
            if (v === shown) {
              if (how === 'tab' || how === 'shift-tab') {
                focusNext(p.key, how === 'tab' ? 1 : -1);
                restoreFocus(view);
              } else render();
              return;
            }
            commitValue(coerce(v, p.type === 'number' ? 'number' : 'text'), how, p.type === 'number' ? 'number' : 'text');
          },
          onCancel: () => {
            render();
            view.focus();
          },
        });
        val.replaceChildren(input);
        input.focus();
        input.select();
      };

      const render = () => {
        val.replaceChildren();
        switch (p.type) {
          case 'checkbox': {
            const box = el('input', 'se-prop-check');
            box.type = 'checkbox';
            box.checked = p.value === true;
            box.setAttribute('aria-label', p.key);
            box.addEventListener('change', () => edit(view, (b) => setProp(b, p.key, box.checked, { type: 'checkbox' })));
            val.appendChild(box);
            break;
          }
          case 'date':
          case 'datetime': {
            const d = el('input', 'se-prop-date');
            d.type = p.type === 'date' ? 'date' : 'datetime-local';
            d.value = dateValue(p);
            d.addEventListener('keydown', (e) => e.stopPropagation());
            d.addEventListener('change', () => {
              if (!d.value) return void edit(view, (b) => setProp(b, p.key, null));
              const v = p.type === 'datetime' ? d.value.replace('T', typeof p.value === 'string' && p.value.includes('T') ? 'T' : ' ') : d.value;
              edit(view, (b) => setProp(b, p.key, v, { type: p.type }));
            });
            val.appendChild(d);
            break;
          }
          case 'list':
          case 'tags': {
            const items = Array.isArray(p.value) ? p.value : [];
            const box = el('div', 'se-pills');
            items.forEach((item, idx) => {
              const pill = el('span', `se-pill${p.type === 'tags' ? ' se-pill-tag' : ''}`);
              const label = el('span', 'se-pill-text');
              if (p.type === 'tags') label.textContent = item;
              else renderInline(item, label);
              label.addEventListener('click', (e) => {
                const link = (e.target as HTMLElement).closest<HTMLElement>('[data-wiki],[data-href]');
                if (link) return void followLinkElement(view, link, e as MouseEvent);
                if (p.type === 'tags') app.openSearch?.(`tag:${item}`);
              });
              const x = el('button', 'se-pill-x');
              x.type = 'button';
              x.title = `Remove ${item}`;
              x.setAttribute('aria-label', `Remove ${item}`);
              x.appendChild(icon('x'));
              x.addEventListener('click', () => edit(view, (b) => setProp(b, p.key, items.filter((_, i) => i !== idx)), { key: p.key, part: 'list' }));
              pill.append(label, x);
              box.appendChild(pill);
            });
            const add = el('input', 'se-pill-input');
            add.placeholder = items.length ? '' : p.type === 'tags' ? 'Add tag…' : 'Add item…';
            add.spellcheck = false;
            add.setAttribute('aria-label', `Add to ${p.key}`);
            const commitAdd = (refocus: boolean) => {
              const extra = coerce(add.value, p.type) as string[];
              if (!extra.length) return false;
              add.value = '';
              edit(view, (b) => setProp(b, p.key, [...items, ...extra.filter((x) => !items.includes(x))], { type: p.type }), refocus ? { key: p.key, part: 'list' } : null);
              return true;
            };
            add.addEventListener('keydown', (e) => {
              e.stopPropagation();
              if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
                e.preventDefault();
                if (!commitAdd(true) && e.key === 'Enter') view.focus();
              } else if (e.key === 'Backspace' && !add.value && items.length) {
                e.preventDefault();
                edit(view, (b) => setProp(b, p.key, items.slice(0, -1), { type: p.type }), { key: p.key, part: 'list' });
              } else if (e.key === 'Escape') {
                add.value = '';
                view.focus();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                focusNext(p.key, e.shiftKey ? -1 : 1);
                if (!commitAdd(false)) restoreFocus(view);
              }
            });
            add.addEventListener('blur', () => void commitAdd(false));
            box.appendChild(add);
            box.addEventListener('mousedown', (e) => {
              if (e.target === box) {
                e.preventDefault();
                add.focus();
              }
            });
            val.appendChild(box);
            break;
          }
          case 'complex': {
            const raw = el('span', 'se-prop-raw', p.raw.trim().split('\n').slice(0, 3).join(' ⏎ ') || '…');
            raw.title = 'Nested YAML — click to edit as YAML';
            raw.addEventListener('click', () => revealYaml(view, p.start));
            val.appendChild(raw);
            break;
          }
          default: {
            const text = el('span', 'se-prop-text');
            text.tabIndex = 0;
            if (p.value === null || p.value === '') {
              text.classList.add('is-empty');
              text.textContent = 'Empty';
            } else renderInline(String(p.value), text);
            text.addEventListener('click', (e) => {
              const link = (e.target as HTMLElement).closest<HTMLElement>('[data-wiki],[data-href]');
              if (link && followLinkElement(view, link, e as MouseEvent)) return;
              startText();
            });
            text.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                startText();
              }
            });
            val.appendChild(text);
          }
        }
      };
      render();
      row.append(keyBtn, val, del);
      rows.appendChild(row);
      rowEls.set(p.key, row);
      (row as HTMLElement & { __edit?: () => void }).__edit = () => {
        if (p.type === 'text' || p.type === 'empty' || p.type === 'number') startText();
        else val.querySelector<HTMLElement>('input')?.focus();
      };
    }
    root.appendChild(rows);

    // ---- add property
    const addRow = el('div', 'se-props-add-row');
    const addBtn = el('button', 'se-props-add');
    addBtn.type = 'button';
    addBtn.append(icon('plus'), document.createTextNode('Add property'));
    const startAdd = () => {
      const input = inlineInput('', {
        placeholder: 'Property name',
        onCommit: (v, how) => {
          const key = v.trim().replace(/:$/, '');
          if (!key) return void input.replaceWith(addBtn);
          if (order.includes(key)) {
            pendingFocus = { key, part: 'value' };
            restoreFocus(view);
            return;
          }
          const type = typeForNewKey(key);
          const initial: PropValue = type === 'tags' || type === 'list' ? [] : type === 'checkbox' ? false : null;
          edit(view, (b) => setProp(b, key, initial, { type }), how === 'blur' ? null : { key, part: 'value' });
        },
        onCancel: () => {
          input.replaceWith(addBtn);
          view.focus();
        },
      });
      input.classList.add('se-prop-key-input');
      addBtn.replaceWith(input);
      input.focus();
    };
    addBtn.addEventListener('click', startAdd);
    addRow.appendChild(addBtn);
    root.appendChild(addRow);

    root.__seFocus = (f: Focus) => {
      if (f.part === 'add') return startAdd();
      const row = f.key ? rowEls.get(f.key) : null;
      if (!row) return;
      if (f.part === 'list') row.querySelector<HTMLInputElement>('.se-pill-input')?.focus();
      else if (f.part === 'key') row.querySelector<HTMLElement>('.se-prop-key')?.click();
      else (row as HTMLElement & { __edit?: () => void }).__edit?.();
    };
    // Built during a dispatch: the old widget may still be in the DOM, so wait until it has been swapped.
    if (pendingFocus) queueMicrotask(() => restoreFocus(view));
    return block;
  }
}

/** Puts the cursor inside the frontmatter → live.ts shows the raw YAML. */
function revealYaml(view: EditorView, bodyLine = 0) {
  const fm = region(view);
  if (!fm) return;
  const lineNo = Math.min(view.state.doc.lineAt(fm.from).number + 1 + bodyLine, view.state.doc.lineAt(fm.to).number);
  const line = view.state.doc.line(lineNo);
  view.focus();
  view.dispatch({ selection: EditorSelection.cursor(line.to), scrollIntoView: true, userEvent: 'select' });
}
