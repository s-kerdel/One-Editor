// Formatting toolbar for Markdown in live (pencil) mode: a CodeMirror top panel, so it stays pinned
// above the scroller. Buttons never take focus from the editor on mouse use (mousedown is cancelled);
// keyboard users reach it with Alt+F10 (roving tabindex, arrows, Escape back to the text).
import type { Extension, StateCommand } from '@codemirror/state';
import { EditorView, keymap, showPanel, type Panel, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { prettyKey } from '../app/commands';
import { icon } from './widgets';
import { formatState, toggleBold, toggleItalic, toggleStrike, toggleHighlight, toggleInlineCode, toggleLineKind, setHeading, insertCodeBlock, insertCallout, insertHorizontalRule, insertMathBlock, type FormatState } from './format';
import { insertTable } from './tables';
import { linkCommand } from './mdkeys';
import { CALLOUT_KINDS } from './slash-items';
import { pickFiles } from './slash';
import { insertFiles } from './paste';

export interface MenuEntry {
  label: string;
  icon?: string;
  tone?: string;
  keys?: string;
  checked?: boolean;
  cls?: string;
  run: () => void;
}

interface Tool {
  id: string;
  label: string;
  icon: string;
  /** CodeMirror key spec shown in the tooltip. */
  keys?: string;
  /** Markdown syntax shown when there is no shortcut. */
  hint?: string;
  group: number;
  on?: (s: FormatState) => boolean;
  run?: (view: EditorView) => void;
  menu?: (view: EditorView) => MenuEntry[];
}

const cmd = (c: StateCommand) => (view: EditorView) => c({ state: view.state, dispatch: view.dispatch });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const HEADING_NAMES = ['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];

/** Sets (never toggles off) the heading level of the selected lines; 0 = paragraph. */
export function applyBlockType(view: EditorView, level: number) {
  if (formatState(view.state).heading === level) return;
  setHeading(level === 0 ? 0 : level)({ state: view.state, dispatch: view.dispatch });
}

export function blockTypeMenu(view: EditorView): MenuEntry[] {
  const cur = formatState(view.state).heading;
  return HEADING_NAMES.map((label, n) => ({
    label,
    icon: n === 0 ? 'pilcrow' : `h${n}`,
    keys: n ? `Mod-${n}` : undefined,
    checked: cur === n,
    cls: `se-fmt-mi-h${n}`,
    run: () => applyBlockType(view, n),
  }));
}

export function calloutMenu(view: EditorView): MenuEntry[] {
  return CALLOUT_KINDS.map((c) => ({ label: cap(c.kind), icon: c.icon, tone: c.kind, run: () => cmd(insertCallout(c.kind))(view) }));
}

async function attach(view: EditorView) {
  const files = await pickFiles('');
  if (files.length) await insertFiles(view, files, null, 'pick');
}

export const TOOLS: Tool[] = [
  { id: 'bold', label: 'Bold', icon: 'bold', keys: 'Mod-b', group: 1, on: (s) => s.bold, run: cmd(toggleBold) },
  { id: 'italic', label: 'Italic', icon: 'italic', keys: 'Mod-i', group: 1, on: (s) => s.italic, run: cmd(toggleItalic) },
  { id: 'strike', label: 'Strikethrough', icon: 'strike', keys: 'Mod-Shift-x', group: 1, on: (s) => s.strike, run: cmd(toggleStrike) },
  { id: 'highlight', label: 'Highlight', icon: 'highlighter', hint: '==text==', group: 1, on: (s) => s.highlight, run: cmd(toggleHighlight) },
  { id: 'code', label: 'Inline code', icon: 'code', hint: '`code`', group: 1, on: (s) => s.code, run: cmd(toggleInlineCode) },
  { id: 'link', label: 'Link', icon: 'link', keys: 'Mod-k', group: 1, on: (s) => s.link, run: (v) => linkCommand(v) },
  { id: 'bullet', label: 'Bullet list', icon: 'list', hint: '-', group: 2, on: (s) => s.bullet, run: cmd(toggleLineKind('bullet')) },
  { id: 'ordered', label: 'Numbered list', icon: 'ordered', hint: '1.', group: 2, on: (s) => s.ordered, run: cmd(toggleLineKind('ordered')) },
  { id: 'task', label: 'Task list', icon: 'task', hint: '- [ ]', group: 2, on: (s) => s.task, run: cmd(toggleLineKind('task')) },
  { id: 'quote', label: 'Quote', icon: 'quote', hint: '>', group: 2, on: (s) => s.quote, run: cmd(toggleLineKind('quote')) },
  { id: 'callout', label: 'Callout', icon: 'info', hint: '> [!note]', group: 2, on: (s) => s.callout, menu: calloutMenu },
  { id: 'codeblock', label: 'Code block', icon: 'code-block', hint: '```', group: 3, on: (s) => s.codeBlock, run: cmd(insertCodeBlock()) },
  { id: 'table', label: 'Table', icon: 'table', group: 3, on: (s) => s.table, run: cmd(insertTable) },
  { id: 'divider', label: 'Divider', icon: 'minus', hint: '---', group: 3, run: cmd(insertHorizontalRule) },
  { id: 'math', label: 'Math block', icon: 'sigma', hint: '$$', group: 3, on: (s) => s.math, run: cmd(insertMathBlock) },
  { id: 'attach', label: 'Image or file', icon: 'paperclip', hint: '![[…]]', group: 3, run: (v) => void attach(v) },
];

// ---------------------------------------------------------------- dropdown menu (shell .se-menu look)

let openMenu: { el: HTMLElement; anchor: HTMLElement; close: (refocus?: boolean) => void } | null = null;

/** Menu anchored under `anchor`. Mouse use keeps editor focus; `keyboard` moves focus into the menu. */
export function showMenu(anchor: HTMLElement, entries: MenuEntry[], opts: { keyboard?: boolean; onClose?: (refocus: boolean) => void; label?: string } = {}) {
  // Clicking the trigger of the open menu closes it (toggle).
  if (openMenu?.anchor === anchor) {
    openMenu.close(true);
    return () => {};
  }
  openMenu?.close();
  const el = document.createElement('div');
  el.className = 'se-menu se-fmt-menu';
  el.setAttribute('role', 'menu');
  if (opts.label) el.setAttribute('aria-label', opts.label);
  el.tabIndex = -1;
  const items: HTMLButtonElement[] = [];
  let sel = -1;
  const select = (i: number) => {
    sel = (i + items.length) % items.length;
    items.forEach((b, j) => b.classList.toggle('selected', j === sel));
    if (opts.keyboard) items[sel].focus();
  };
  const close = (refocus = false) => {
    if (openMenu?.el !== el) return;
    openMenu = null;
    el.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('blur', blurClose);
    window.removeEventListener('resize', blurClose);
    anchor.setAttribute('aria-expanded', 'false');
    opts.onClose?.(refocus);
  };
  const outside = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const blurClose = () => close();
  for (const entry of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `se-menu-item${entry.cls ? ` ${entry.cls}` : ''}`;
    b.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (entry.checked !== undefined) b.setAttribute('aria-checked', String(entry.checked));
    b.tabIndex = -1;
    const ic = document.createElement('span');
    ic.className = 'se-menu-icon';
    if (entry.tone) ic.dataset.tone = entry.tone;
    if (entry.icon) ic.appendChild(icon(entry.icon));
    const label = document.createElement('span');
    label.className = 'se-menu-label';
    label.textContent = entry.label;
    b.append(ic, label);
    if (entry.keys) {
      const k = document.createElement('span');
      k.className = 'se-menu-keys';
      k.textContent = prettyKey(entry.keys);
      b.appendChild(k);
    }
    if (entry.checked) {
      const c = icon('check', 'se-icon se-fmt-menu-check');
      b.appendChild(c);
    }
    const i = items.length;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('mouseenter', () => select(i));
    b.addEventListener('click', () => {
      close(true);
      entry.run();
    });
    items.push(b);
    el.appendChild(b);
  }
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') select(sel + 1);
    else if (e.key === 'ArrowUp') select(sel - 1);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') close(true);
    else if ((e.key === 'Enter' || e.key === ' ') && sel >= 0) items[sel].click();
    else return;
    e.preventDefault();
  });
  el.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const x = Math.max(4, Math.min(r.left, innerWidth - w - 4));
  const y = r.bottom + 4 + h > innerHeight - 4 ? Math.max(4, r.top - h - 4) : r.bottom + 4;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  anchor.setAttribute('aria-expanded', 'true');
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('blur', blurClose);
  window.addEventListener('resize', blurClose);
  openMenu = { el, anchor, close };
  if (opts.keyboard) {
    const checked = entries.findIndex((x) => x.checked);
    select(checked >= 0 ? checked : 0);
  }
  return close;
}

// ---------------------------------------------------------------- toolbar panel

function tooltipText(t: { label: string; keys?: string; hint?: string }) {
  return { label: t.label, side: t.keys ? prettyKey(t.keys) : t.hint ?? '' };
}

class Toolbar implements Panel {
  dom: HTMLElement;
  top = true;
  private bar: HTMLElement;
  private block: HTMLButtonElement;
  private blockLabel: HTMLElement;
  private more: HTMLButtonElement;
  private buttons = new Map<string, HTMLButtonElement>();
  /** Bar children in order (tools, separators, more) with their natural widths, for overflow. */
  private parts: Array<{ el: HTMLElement; tool?: Tool; sep?: boolean; w: number }> = [];
  private hidden = new Set<string>();
  private key = '';
  private tip: HTMLElement;
  private tipTimer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver | null = null;
  private lastWidth = -1;
  private measured = false;

  constructor(readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'se-fmtbar';
    const bar = (this.bar = document.createElement('div'));
    bar.className = 'se-fmtbar-inner';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Formatting');
    bar.setAttribute('aria-orientation', 'horizontal');

    this.block = this.button('block', 'se-fmt-btn se-fmt-block');
    this.block.setAttribute('aria-haspopup', 'menu');
    this.block.setAttribute('aria-label', 'Text style');
    this.blockLabel = document.createElement('span');
    this.blockLabel.className = 'se-fmt-block-label';
    this.blockLabel.textContent = HEADING_NAMES[0];
    this.block.append(this.blockLabel, icon('chevron', 'se-icon se-fmt-caret'));
    this.wireTip(this.block, { label: 'Text style', side: '' });
    this.block.addEventListener('click', (e) => this.openBlockMenu(e.detail === 0));
    bar.appendChild(this.block);
    this.parts.push({ el: this.block, w: 0 });

    let group = 0;
    for (const t of TOOLS) {
      if (t.group !== group) {
        group = t.group;
        const sep = document.createElement('span');
        sep.className = 'se-fmt-sep';
        sep.setAttribute('role', 'separator');
        bar.appendChild(sep);
        this.parts.push({ el: sep, sep: true, w: 0 });
      }
      const b = this.button(t.id, `se-fmt-btn${t.menu ? ' se-fmt-has-menu' : ''}`);
      b.setAttribute('aria-label', t.label);
      if (t.on) b.setAttribute('aria-pressed', 'false');
      if (t.menu) b.setAttribute('aria-haspopup', 'menu');
      b.appendChild(icon(t.icon));
      if (t.menu) b.appendChild(icon('chevron', 'se-icon se-fmt-mini-caret'));
      this.wireTip(b, tooltipText(t));
      b.addEventListener('click', (e) => this.activate(t, b, e.detail === 0));
      this.buttons.set(t.id, b);
      bar.appendChild(b);
      this.parts.push({ el: b, tool: t, w: 0 });
    }
    this.more = this.button('more', 'se-fmt-btn se-fmt-more');
    this.more.setAttribute('aria-label', 'More formatting');
    this.more.setAttribute('aria-haspopup', 'menu');
    this.more.appendChild(icon('ellipsis'));
    this.more.hidden = true;
    this.wireTip(this.more, { label: 'More', side: '' });
    this.more.addEventListener('click', (e) => this.openMore(e.detail === 0));
    bar.appendChild(this.more);

    this.tip = document.createElement('div');
    this.tip.className = 'se-fmt-tip';
    this.tip.setAttribute('role', 'tooltip');
    this.tip.hidden = true;

    bar.addEventListener('keydown', (e) => this.onKey(e));
    this.dom.append(bar, this.tip);
    this.block.tabIndex = 0;
    this.sync();
  }

  private button(id: string, cls: string) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.dataset.tool = id;
    b.tabIndex = -1;
    // Mouse: keep the caret (and the revealed syntax) in the editor.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  }

  private wireTip(b: HTMLElement, t: { label: string; side: string }) {
    const show = (delay: number) => {
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTimer = setTimeout(() => {
        if (b.getAttribute('aria-expanded') === 'true') return;
        this.tip.replaceChildren(document.createTextNode(t.label));
        if (t.side) {
          const k = document.createElement('span');
          k.className = 'se-fmt-tip-keys';
          k.textContent = t.side;
          this.tip.appendChild(k);
        }
        this.tip.hidden = false;
        const r = b.getBoundingClientRect();
        const w = this.tip.offsetWidth;
        this.tip.style.left = `${Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4))}px`;
        this.tip.style.top = `${r.bottom + 6}px`;
      }, delay);
    };
    const hide = () => {
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTimer = null;
      this.tip.hidden = true;
    };
    b.addEventListener('mouseenter', () => show(this.tip.hidden ? 450 : 0));
    b.addEventListener('mouseleave', hide);
    b.addEventListener('mousedown', hide);
    b.addEventListener('focus', () => b.matches(':focus-visible') && show(150));
    b.addEventListener('blur', hide);
  }

  private activate(t: Tool, b: HTMLButtonElement, keyboard: boolean) {
    if (t.menu) {
      showMenu(b, t.menu(this.view), { keyboard, label: t.label, onClose: (refocus) => refocus && this.view.focus() });
      return;
    }
    t.run?.(this.view);
    this.view.focus();
  }

  private openBlockMenu(keyboard: boolean) {
    showMenu(this.block, blockTypeMenu(this.view), { keyboard, label: 'Text style', onClose: (refocus) => refocus && this.view.focus() });
  }

  private openMore(keyboard: boolean) {
    const entries: MenuEntry[] = [];
    for (const p of this.parts) {
      const t = p.tool;
      if (!t || !this.hidden.has(t.id)) continue;
      entries.push({
        label: t.menu ? `${t.label}…` : t.label,
        icon: t.icon,
        keys: t.keys,
        run: () => {
          if (t.menu) requestAnimationFrame(() => showMenu(this.more, t.menu!(this.view), { keyboard, label: t.label, onClose: (r) => r && this.view.focus() }));
          else {
            t.run?.(this.view);
            this.view.focus();
          }
        },
      });
    }
    showMenu(this.more, entries, { keyboard, label: 'More formatting', onClose: (refocus) => refocus && this.view.focus() });
  }

  /** Visible, focusable controls in order. */
  private controls(): HTMLButtonElement[] {
    return [...this.bar.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.hidden);
  }

  private onKey(e: KeyboardEvent) {
    const list = this.controls();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      this.view.focus();
      return;
    } else if (e.key === 'ArrowDown' && list[i]?.getAttribute('aria-haspopup')) {
      e.preventDefault();
      list[i].click();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    for (const b of list) b.tabIndex = -1;
    list[next].tabIndex = 0;
    list[next].focus();
  }

  /** Alt+F10 / palette: move keyboard focus into the toolbar. */
  focusFirst() {
    const list = this.controls();
    const target = list.find((b) => b.tabIndex === 0) ?? list[0];
    target?.focus();
  }

  /** Lights the buttons for the current selection. Cheap: a few resolveInner calls. */
  private sync() {
    const s = formatState(this.view.state);
    let key = String(s.heading);
    for (const t of TOOLS) key += t.on?.(s) ? '1' : '0';
    if (key === this.key) return;
    this.key = key;
    this.blockLabel.textContent = HEADING_NAMES[s.heading] ?? HEADING_NAMES[0];
    this.block.classList.toggle('is-heading', s.heading > 0);
    for (const t of TOOLS) {
      if (!t.on) continue;
      const on = t.on(s);
      const b = this.buttons.get(t.id)!;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  update(u: ViewUpdate) {
    if (u.selectionSet || u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.sync();
  }

  mount() {
    this.scheduleLayout();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.scheduleLayout());
      this.ro.observe(this.dom);
    }
  }

  private scheduleLayout() {
    this.view.requestMeasure({
      key: this,
      read: () => {
        const cs = getComputedStyle(this.bar);
        const avail = this.bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        // Natural widths, measured once while everything is still visible (skipped while the editor is hidden).
        if (!this.measured && avail > 0) {
          const gap = parseFloat(cs.columnGap) || 0;
          for (const p of this.parts) p.w = p.el.getBoundingClientRect().width + gap;
          this.measured = true;
        }
        return avail;
      },
      write: (avail) => this.layout(avail),
    });
  }

  private layout(avail: number) {
    if (avail <= 0 || !this.measured || avail === this.lastWidth) return;
    this.lastWidth = avail;
    const total = this.parts.reduce((a, p) => a + p.w, 0);
    const moreW = 32;
    let used = 0;
    let overflow = total > avail;
    const hidden = new Set<string>();
    for (const p of this.parts) {
      const fits = !overflow || used + p.w <= avail - moreW;
      if (fits) used += p.w;
      if (p.tool) {
        if (!fits) hidden.add(p.tool.id);
        p.el.hidden = !fits;
      } else if (p.sep) p.el.hidden = !fits;
      if (!fits) overflow = true;
    }
    // A trailing separator before the "more" button looks odd.
    const visible = this.parts.filter((p) => !p.el.hidden);
    if (visible.length && visible[visible.length - 1].sep) visible[visible.length - 1].el.hidden = true;
    this.hidden = hidden;
    this.more.hidden = hidden.size === 0;
  }

  destroy() {
    this.ro?.disconnect();
    if (this.tipTimer) clearTimeout(this.tipTimer);
    openMenu?.close();
  }
}

const toolbars = new WeakMap<EditorView, Toolbar>();

function createToolbar(view: EditorView): Panel {
  const t = new Toolbar(view);
  toolbars.set(view, t);
  return t;
}

/** Focus the toolbar of `view` (false when it isn't shown). */
export function focusToolbar(view: EditorView): boolean {
  const t = toolbars.get(view);
  if (!t || !view.dom.contains(t.dom)) return false;
  t.focusFirst();
  return true;
}

export const FORMAT_TOOLBAR: Extension = [
  showPanel.of(createToolbar),
  keymap.of([{ key: 'Alt-F10', run: focusToolbar, preventDefault: true }]),
  EditorView.editorAttributes.of({ class: 'se-has-fmtbar' }),
];
