// Slash menu: "/" at line start or after whitespace opens a fuzzy-searchable insert menu (tooltip).
// The session lives in a StateField (start of the "/", current submenu); the typed query is the doc
// text after it, so Backspace/undo/typing all just work. Submenus rewrite the query to "/callout "
// and filter on what follows; Backspace over that space returns to the root menu.
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type TooltipView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { startCompletion } from '@codemirror/autocomplete';
import { basename, dirname, isMarkdown, normalize, stem } from '@shared/paths';
import { app } from '../app/app';
import { listCommands, prettyKey, runCommand, getCommand } from '../app/commands';
import { applyTemplate } from '../../knowledge/templates';
import { CALLOUT_KINDS, calloutItems, dateItems, filterSlashItems, parseTableSize, rootItems, slashTransaction, slashTriggerOk, type SlashItem, type SlashMatch } from './slash-items';
import { inCodeContext } from './mdkeys';
import { docPath } from './host';
import { icon } from './widgets';
import { IMAGE_EXT_RE, linkMarkdown } from './attachments';
import { insertFiles } from './paste';
import { openPropertiesEditor } from './properties';

interface Session {
  /** Position of the "/". */
  from: number;
  menu: string | null;
  /** Start of the submenu query. */
  subFrom: number;
  selected: number;
  grid: { cols: number; rows: number };
}

const openSlash = StateEffect.define<number>();
const closeSlash = StateEffect.define<null>();
const enterMenu = StateEffect.define<{ menu: string; subFrom: number }>();
const selectItem = StateEffect.define<number>();
const setGrid = StateEffect.define<{ cols: number; rows: number }>();
const toRoot = StateEffect.define<null>();

const BLOCKED = new Set(['URL', 'Autolink', 'Link', 'Image', 'WikiLink', 'WikiEmbed', 'LinkReference', 'Comment', 'ObsidianComment', 'ObsidianCommentBlock']);

/** "/" inside code, math, frontmatter, URLs or links never opens the menu. */
export function slashAllowed(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  if (!slashTriggerOk(line.text.slice(0, pos - line.from))) return false;
  if (inCodeContext(state, pos) || inCodeContext(state, pos + 1)) return false;
  for (let n: { name: string; parent: any } | null = syntaxTree(state).resolveInner(pos + 1, -1); n; n = n.parent) if (BLOCKED.has(n.name)) return false;
  // Unclosed inline code on this line ("`foo /").
  if (((line.text.slice(0, pos - line.from).match(/`/g) ?? []).length & 1) === 1) return false;
  return true;
}

function validate(s: Session, state: EditorState): Session | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const head = sel.main.head;
  if (state.sliceDoc(s.from, s.from + 1) !== '/' || head <= s.from) return null;
  const line = state.doc.lineAt(s.from);
  if (head > line.to || head - s.from > 80) return null;
  const query = state.sliceDoc(s.from + 1, head);
  if (/^\s/.test(query) || /\s{2}$/.test(query)) return null;
  if (s.menu && head < s.subFrom) return { ...s, menu: null, subFrom: s.from + 1, selected: 0 };
  return s;
}

const slashField = StateField.define<Session | null>({
  create: () => null,
  update(v, tr) {
    if (v && tr.docChanged) {
      const from = tr.changes.mapPos(v.from, 1);
      v = { ...v, from, subFrom: tr.changes.mapPos(v.subFrom, -1), selected: 0 };
    }
    for (const e of tr.effects) {
      if (e.is(openSlash)) v = { from: e.value, menu: null, subFrom: e.value + 1, selected: 0, grid: { cols: 3, rows: 3 } };
      else if (e.is(closeSlash)) return null;
      else if (e.is(enterMenu) && v) v = { ...v, menu: e.value.menu, subFrom: e.value.subFrom, selected: 0 };
      else if (e.is(selectItem) && v) v = { ...v, selected: e.value };
      else if (e.is(setGrid) && v) v = { ...v, grid: e.value };
      else if (e.is(toRoot) && v) v = { ...v, menu: null, subFrom: v.from + 1, selected: 0 };
    }
    if (!v && tr.docChanged && tr.isUserEvent('input.type') && tr.state.selection.ranges.length === 1) {
      let pos = -1;
      let count = 0;
      tr.changes.iterChanges((fA, tA, fB, _tB, ins) => {
        count++;
        if (fA === tA && ins.length === 1 && ins.sliceString(0) === '/') pos = fB;
      });
      if (count === 1 && pos >= 0 && tr.state.selection.main.head === pos + 1 && slashAllowed(tr.state, pos)) {
        return { from: pos, menu: null, subFrom: pos + 1, selected: 0, grid: { cols: 3, rows: 3 } };
      }
      return null;
    }
    return v && (tr.docChanged || tr.selection) ? validate(v, tr.state) : v;
  },
  provide: (f) => showTooltip.compute([f], (state): Tooltip | null => {
    const s = state.field(f);
    return s ? { pos: s.from, above: false, strictSide: false, arrow: false, create: createMenu } : null;
  }),
});

// ---------------------------------------------------------------- items

const ROOT = rootItems();
const MENU_TITLES: Record<string, string> = { table: 'Table', callout: 'Callout', date: 'Date / time', image: 'Image', template: 'Template', command: 'Run command' };

function setting(key: string, fallback: string): string {
  const v = app.settings.value[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** Template files: knowledge's list when it exposes one, else Markdown files in `templates.folder`. */
function templateFiles(): string[] {
  const k = (app as unknown as { knowledge?: { templates?: () => unknown } }).knowledge;
  try {
    const t = k?.templates?.();
    if (Array.isArray(t)) return t.map((x) => (typeof x === 'string' ? x : (x as { path?: string })?.path)).filter((x): x is string => !!x);
  } catch {}
  const folder = normalize(setting('templates.folder', 'templates')).toLowerCase();
  return app.files.value.filter((f) => isMarkdown(f) && f.toLowerCase().startsWith(`${folder}/`)).sort((a, b) => a.localeCompare(b));
}

function menuItems(menu: string, notePath: string): SlashItem[] {
  switch (menu) {
    case 'callout':
      return calloutItems(false);
    case 'date':
      return dateItems(new Date(), setting('templates.dateFormat', 'YYYY-MM-DD'), setting('templates.timeFormat', 'HH:mm'));
    case 'image': {
      const imgs = app.files.value.filter((f) => IMAGE_EXT_RE.test(f));
      const near = dirname(notePath);
      imgs.sort((a, b) => Number(dirname(b) === near) - Number(dirname(a) === near) || a.localeCompare(b));
      return [
        { id: 'upload', title: 'Upload from computer…', icon: 'upload', keywords: ['file', 'browse', 'pick'], special: 'upload' },
        ...imgs.map((p) => ({ id: p, title: basename(p), hint: dirname(p) || undefined, icon: 'image', keywords: [p], special: 'image', data: p })),
      ];
    }
    case 'template': {
      const files = templateFiles();
      if (!files.length) return [{ id: 'none', title: `No templates in "${setting('templates.folder', 'templates')}/"`, icon: 'template', special: 'template-help', hint: 'How?' }];
      return files.map((p) => ({ id: p, title: stem(p), hint: dirname(p), icon: 'template', special: 'template', data: p }));
    }
    case 'command':
      return listCommands()
        .filter((c) => c.id !== 'editor.slashMenu')
        .map((c) => {
          const key = c.keys?.[0] ?? c.displayKeys?.[0];
          return { id: c.id, title: c.title, icon: 'terminal', hint: key ? prettyKey(key) : c.category, keywords: [...(c.keywords ?? []), ...(c.category ? [c.category] : [])], special: 'command', data: c.id };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
  }
  return [];
}

interface Computed {
  query: string;
  matches: SlashMatch[];
  grouped: boolean;
}

function compute(state: EditorState, s: Session): Computed {
  const head = state.selection.main.head;
  if (!s.menu) {
    const query = state.sliceDoc(s.from + 1, head);
    // Date shortcuts ("/today", "/now") are searchable from the root; they depend on the clock + settings.
    const items = query.trim() ? [...ROOT, ...dateItems(new Date(), setting('templates.dateFormat', 'YYYY-MM-DD'), setting('templates.timeFormat', 'HH:mm'), true)] : ROOT;
    return { query, matches: filterSlashItems(query, items), grouped: !query.trim() };
  }
  const query = state.sliceDoc(s.subFrom, head);
  const items = menuItems(s.menu, state.facet(docPath));
  return { query, matches: filterSlashItems(query, items, s.menu === 'command' || s.menu === 'image' ? 200 : 60), grouped: false };
}

// ---------------------------------------------------------------- actions

function closeAll(view: EditorView) {
  if (view.state.field(slashField, false)) view.dispatch({ effects: closeSlash.of(null) });
}

/** Removes "/query" and closes the menu; returns the position the slash was at. */
function removeQuery(view: EditorView): number {
  const s = view.state.field(slashField)!;
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: s.from, to: head }, selection: EditorSelection.cursor(s.from), effects: closeSlash.of(null), userEvent: 'input.slash' });
  return s.from;
}

function enterSubmenu(view: EditorView, menu: string) {
  const s = view.state.field(slashField)!;
  const head = view.state.selection.main.head;
  const text = `${menu} `;
  view.dispatch({
    changes: { from: s.from + 1, to: head, insert: text },
    selection: EditorSelection.cursor(s.from + 1 + text.length),
    effects: enterMenu.of({ menu, subFrom: s.from + 1 + text.length }),
    userEvent: 'input.slash',
  });
}

function backToRoot(view: EditorView) {
  const s = view.state.field(slashField)!;
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: s.from + 1, to: head }, selection: EditorSelection.cursor(s.from + 1), effects: toRoot.of(null), userEvent: 'input.slash' });
}

function insertTable(view: EditorView, cols: number, rows: number) {
  const s = view.state.field(slashField)!;
  const head = view.state.selection.main.head;
  view.dispatch({ ...slashTransaction(view.state, s.from, head, { type: 'table', cols, rows }), effects: closeSlash.of(null) });
}

export function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function insertTemplate(view: EditorView, from: number, path: string) {
  try {
    const tpl = await app.backend.readFile(path);
    const note = view.state.facet(docPath);
    const text = applyTemplate(tpl.content, { title: stem(note), dateFormat: setting('templates.dateFormat', 'YYYY-MM-DD'), timeFormat: setting('templates.timeFormat', 'HH:mm') });
    const at = Math.min(from, view.state.doc.length);
    view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: 'input.slash', scrollIntoView: true });
    view.focus();
  } catch (err) {
    app.toast(`Template failed: ${(err as Error)?.message ?? err}`, 'error');
  }
}

export function activate(view: EditorView, item: SlashItem) {
  const s = view.state.field(slashField, false);
  if (!s || item.disabled) return;
  const head = view.state.selection.main.head;
  if (item.submenu) return enterSubmenu(view, item.submenu);
  if (item.action) {
    view.dispatch({ ...slashTransaction(view.state, s.from, head, item.action), effects: closeSlash.of(null) });
    if (item.complete) startCompletion(view);
    return;
  }
  const note = view.state.facet(docPath);
  switch (item.special) {
    case 'properties': {
      removeQuery(view);
      openPropertiesEditor(view);
      return;
    }
    case 'image': {
      const text = linkMarkdown(item.data!, app.files.value, note, true);
      view.dispatch({ changes: { from: s.from, to: head, insert: text }, selection: EditorSelection.cursor(s.from + text.length), effects: closeSlash.of(null), userEvent: 'input.slash' });
      return;
    }
    case 'upload': {
      const at = removeQuery(view);
      void pickFiles('image/*').then((files) => {
        if (files.length) void insertFiles(view, files, { from: at, to: at }, 'pick');
      });
      return;
    }
    case 'template': {
      const at = removeQuery(view);
      void insertTemplate(view, at, item.data!);
      return;
    }
    case 'template-help':
      removeQuery(view);
      if (getCommand('knowledge.insertTemplate')) void runCommand('knowledge.insertTemplate');
      else app.toast(`Put Markdown files in a "${setting('templates.folder', 'templates')}/" folder to use them as templates`, 'info', 5000);
      return;
    case 'command': {
      removeQuery(view);
      // After this keystroke's handling, so the command sees the cleaned-up editor.
      setTimeout(() => void runCommand(item.data!).catch((err) => app.toast(`Command failed: ${(err as Error)?.message ?? err}`, 'error')), 0);
      return;
    }
  }
}

// ---------------------------------------------------------------- keyboard

function withMenu(fn: (view: EditorView, s: Session, c: Computed) => boolean) {
  return (view: EditorView) => {
    const s = view.state.field(slashField, false);
    if (!s) return false;
    return fn(view, s, compute(view.state, s));
  };
}

const clampGrid = (cols: number, rows: number) => ({ cols: Math.min(Math.max(cols, 1), 10), rows: Math.min(Math.max(rows, 2), 12) });

function move(delta: number) {
  return withMenu((view, s, c) => {
    if (s.menu === 'table') {
      view.dispatch({ effects: setGrid.of(clampGrid(s.grid.cols, s.grid.rows + Math.sign(delta))) });
      return true;
    }
    const n = c.matches.length;
    if (!n) return false;
    let next = s.selected + delta;
    if (Math.abs(delta) === 1) next = (next + n) % n;
    else next = Math.min(Math.max(next, 0), n - 1);
    view.dispatch({ effects: selectItem.of(next) });
    return true;
  });
}

const slashKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: move(1) },
    { key: 'ArrowUp', run: move(-1) },
    { key: 'Ctrl-n', run: move(1) },
    { key: 'Ctrl-p', run: move(-1) },
    { key: 'PageDown', run: move(8) },
    { key: 'PageUp', run: move(-8) },
    {
      key: 'ArrowLeft',
      run: withMenu((view, s, c) => {
        if (s.menu === 'table' && s.grid.cols > 1) {
          view.dispatch({ effects: setGrid.of(clampGrid(s.grid.cols - 1, s.grid.rows)) });
          return true;
        }
        if (s.menu && !c.query) {
          backToRoot(view);
          return true;
        }
        return false;
      }),
    },
    {
      key: 'ArrowRight',
      run: withMenu((view, s, c) => {
        if (s.menu === 'table') {
          view.dispatch({ effects: setGrid.of(clampGrid(s.grid.cols + 1, s.grid.rows)) });
          return true;
        }
        const item = c.matches[s.selected]?.item;
        if (item?.submenu && view.state.selection.main.head === view.state.doc.lineAt(s.from).to) {
          enterSubmenu(view, item.submenu);
          return true;
        }
        return false;
      }),
    },
    ...['Enter', 'Tab'].map((key) => ({
      key,
      run: withMenu((view, s, c) => {
        if (s.menu === 'table') {
          const typed = parseTableSize(c.query);
          insertTable(view, typed?.cols ?? s.grid.cols, typed?.rows ?? s.grid.rows);
          return true;
        }
        const m = c.matches[Math.min(s.selected, c.matches.length - 1)];
        if (!m) {
          closeAll(view);
          return false;
        }
        activate(view, m.item);
        return true;
      }),
    })),
    {
      key: 'Escape',
      run: withMenu((view) => {
        closeAll(view);
        return true;
      }),
    },
  ]),
);

// ---------------------------------------------------------------- view

function highlight(title: string, positions: number[]): Node[] {
  if (!positions.length) return [document.createTextNode(title)];
  const set = new Set(positions);
  const out: Node[] = [];
  let buf = '';
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) {
      const m = document.createElement('mark');
      m.textContent = buf;
      out.push(m);
    } else out.push(document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < title.length; i++) {
    const hit = set.has(i);
    if (hit !== inMark) {
      flush();
      inMark = hit;
    }
    buf += title[i];
  }
  flush();
  return out;
}

const CALLOUT_SET = new Set(CALLOUT_KINDS.map((c) => c.kind));

function createMenu(view: EditorView): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'se-slash';
  dom.setAttribute('role', 'listbox');
  dom.setAttribute('aria-label', 'Insert');
  let lastKey = '';
  const onDown = (e: MouseEvent) => e.preventDefault(); // keep editor focus
  dom.addEventListener('mousedown', onDown);

  const render = () => {
    const s = view.state.field(slashField, false);
    if (!s) return;
    const c = compute(view.state, s);
    const key = `${s.menu}|${c.query}|${s.selected}|${s.grid.cols}x${s.grid.rows}|${c.matches.length}`;
    if (key === lastKey) return;
    lastKey = key;
    dom.replaceChildren();
    dom.dataset.menu = s.menu ?? 'root';
    if (s.menu) {
      const head = document.createElement('div');
      head.className = 'se-slash-head';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'se-slash-back';
      back.title = 'Back (←)';
      back.appendChild(icon('chevron', 'se-icon se-slash-back-icon'));
      back.addEventListener('click', () => backToRoot(view));
      const t = document.createElement('span');
      t.textContent = MENU_TITLES[s.menu] ?? s.menu;
      head.append(back, t);
      dom.appendChild(head);
    }
    if (s.menu === 'table') {
      renderGrid(view, dom, s, c.query);
      return;
    }
    const list = document.createElement('div');
    list.className = 'se-slash-list';
    let group = '';
    let selectedEl: HTMLElement | null = null;
    const sel = Math.min(s.selected, c.matches.length - 1);
    c.matches.forEach((m, i) => {
      if (c.grouped && m.item.group && m.item.group !== group) {
        group = m.item.group;
        const g = document.createElement('div');
        g.className = 'se-slash-group';
        g.textContent = group;
        list.appendChild(g);
      }
      const row = document.createElement('div');
      row.className = 'se-slash-item' + (i === sel ? ' is-selected' : '') + (m.item.disabled ? ' is-disabled' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === sel));
      row.dataset.id = m.item.id;
      const ic = document.createElement('span');
      ic.className = 'se-slash-icon';
      if (m.item.tone && CALLOUT_SET.has(m.item.tone)) ic.dataset.tone = m.item.tone;
      ic.appendChild(icon(m.item.icon));
      const title = document.createElement('span');
      title.className = 'se-slash-title';
      title.append(...highlight(m.item.title, m.positions));
      row.append(ic, title);
      if (m.item.hint) {
        const hint = document.createElement('span');
        hint.className = 'se-slash-hint';
        hint.textContent = m.item.hint;
        row.appendChild(hint);
      }
      if (m.item.submenu) row.appendChild(icon('chevron-right', 'se-icon se-slash-more'));
      row.addEventListener('mousemove', () => {
        const cur = view.state.field(slashField, false);
        if (cur && cur.selected !== i) view.dispatch({ effects: selectItem.of(i) });
      });
      row.addEventListener('click', () => activate(view, m.item));
      list.appendChild(row);
      if (i === sel) selectedEl = row;
    });
    if (!c.matches.length) {
      const empty = document.createElement('div');
      empty.className = 'se-slash-empty';
      empty.textContent = 'No matches';
      list.appendChild(empty);
    }
    dom.appendChild(list);
    const foot = document.createElement('div');
    foot.className = 'se-slash-foot';
    foot.textContent = '↑↓ select   ↵ insert   esc close';
    dom.appendChild(foot);
    if (selectedEl) requestAnimationFrame(() => (selectedEl as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }));
  };

  return {
    dom,
    mount: render,
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.startState.field(slashField, false) !== u.state.field(slashField, false)) render();
      // Typing on past every match (e.g. "/ 2 apples") closes the menu instead of hijacking Enter.
      const s = u.state.field(slashField, false);
      if (s && u.docChanged) {
        const c = compute(u.state, s);
        if (!c.matches.length && s.menu !== 'table' && (/\s$/.test(c.query) || c.query.length > 24)) queueMicrotask(() => closeAll(u.view));
      }
    },
  };
}

function renderGrid(view: EditorView, dom: HTMLElement, s: Session, query: string) {
  const typed = parseTableSize(query);
  const size = typed ?? s.grid;
  const wrap = document.createElement('div');
  wrap.className = 'se-slash-grid-wrap';
  const grid = document.createElement('div');
  grid.className = 'se-slash-grid';
  const MAXC = 8;
  const MAXR = 8;
  grid.style.gridTemplateColumns = `repeat(${MAXC}, 1fr)`;
  for (let r = 1; r <= MAXR; r++) {
    for (let col = 1; col <= MAXC; col++) {
      const cell = document.createElement('div');
      cell.className = 'se-slash-cell' + (col <= size.cols && r <= size.rows ? ' is-on' : '') + (r === 1 ? ' is-header' : '');
      cell.dataset.cols = String(col);
      cell.dataset.rows = String(r);
      cell.addEventListener('mousemove', () => {
        const cur = view.state.field(slashField, false);
        if (cur && (cur.grid.cols !== col || cur.grid.rows !== r) && r >= 2) view.dispatch({ effects: setGrid.of({ cols: col, rows: r }) });
      });
      cell.addEventListener('click', () => insertTable(view, col, Math.max(r, 2)));
      grid.appendChild(cell);
    }
  }
  const label = document.createElement('div');
  label.className = 'se-slash-grid-label';
  label.textContent = `${size.cols} × ${size.rows} table`;
  const hint = document.createElement('span');
  hint.textContent = '  · header + ' + (size.rows - 1) + (size.rows - 1 === 1 ? ' row' : ' rows');
  label.appendChild(hint);
  wrap.append(grid, label);
  dom.appendChild(wrap);
  const foot = document.createElement('div');
  foot.className = 'se-slash-foot';
  foot.textContent = 'arrows resize   ↵ insert   or type 4x5';
  dom.appendChild(foot);
}

/** Closes the menu when the editor loses focus (clicks inside the menu keep focus). */
const blurClose = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate) {
      if (u.focusChanged && !u.view.hasFocus && u.state.field(slashField, false)) {
        const view = u.view;
        setTimeout(() => !view.hasFocus && closeAll(view), 0);
      }
    }
  },
);

/** Palette command: open the menu at the cursor (inserts the "/"). */
export function openSlashMenu(view: EditorView) {
  const r = view.state.selection.main;
  const line = view.state.doc.lineAt(r.head);
  const before = line.text.slice(0, r.head - line.from);
  const insert = slashTriggerOk(before) ? '/' : ' /';
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.cursor(r.from + insert.length), effects: openSlash.of(r.from + insert.length - 1), userEvent: 'input.slash' });
  view.focus();
}

export function slashMenu(): Extension {
  return [slashField, slashKeymap, blurClose];
}

/** Test/introspection helper: whether the menu is open in `state`. */
export function slashOpen(state: EditorState): boolean {
  return !!state.field(slashField, false);
}
