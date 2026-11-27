// Live-preview widgets. DOM is built with textContent / createElement only (no user HTML).
import { ViewPlugin, WidgetType, type EditorView } from '@codemirror/view';
import { syntaxTree, foldable, foldEffect, unfoldEffect, foldedRanges } from '@codemirror/language';
import { toggleTaskAt } from './lists';
import { splitRow, isDelimiterRow, cellRanges } from './tables';
import { renderInline } from './inline-render';
import { followLinkElement } from './links';
import { docPath } from './host';
import { app } from '../app/app';
import { copyableCode, isRunnableFence } from '../terminal/run';
import { codeAction } from '../variables/cm';
import { remoteAllowed } from '../preview/remote';
import type { CodeHeaderVars } from '../variables/api';

const SVG: Record<string, string> = {
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  todo: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v5"/><path d="M12 17v5"/><path d="M2 12h5"/><path d="M17 12h5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  // Slash menu / properties (lucide)
  h1: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>',
  h2: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
  h3: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>',
  heading: '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  ordered: '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  minus: '<path d="M5 12h14"/>',
  sigma: '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  template: '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>',
  footnote: '<path d="m4 19 8-8"/><path d="m12 19-8-8"/><path d="M20 12h-4c0-1.5.442-2 1.5-2.5S20 8.334 20 7.002c0-.472-.17-.93-.484-1.29a2.105 2.105 0 0 0-2.617-.436c-.42.239-.738.614-.899 1.06"/>',
  tags: '<path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/><path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="6.5" cy="9.5" r=".5" fill="currentColor"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  text: '<path d="M17 6.1H3"/><path d="M21 12.1H3"/><path d="M15.1 18H3"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  external: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  sliders: '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  checkbox: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  'calendar-clock': '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>',
  // Formatting toolbar (lucide)
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  'code-block': '<path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  paperclip: '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
  h4: '<path d="M12 18V6"/><path d="M17 10v3a1 1 0 0 0 1 1h3"/><path d="M21 10v8"/><path d="M4 12h8"/><path d="M4 18V6"/>',
  h5: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 13v-3h4"/><path d="M17 17.7c.4.2.8.3 1.3.3 1.5 0 2.7-1.1 2.7-2.5S19.8 13 18.3 13H17"/>',
  h6: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><circle cx="19" cy="16" r="2"/><path d="M20 10c-2 2-3 3.5-3 6"/>',
  pilcrow: '<path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
};

const iconTemplates = new Map<string, SVGSVGElement>();

/** Inline SVG icon. Parsed once per name, then cloned (widgets create many: checkboxes, fold arrows…). */
export function icon(name: string, cls = 'se-icon'): SVGSVGElement {
  let tpl = iconTemplates.get(name);
  if (!tpl) {
    tpl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tpl.setAttribute('viewBox', '0 0 24 24');
    tpl.setAttribute('fill', 'none');
    tpl.setAttribute('stroke', 'currentColor');
    tpl.setAttribute('stroke-width', '2');
    tpl.setAttribute('stroke-linecap', 'round');
    tpl.setAttribute('stroke-linejoin', 'round');
    tpl.setAttribute('aria-hidden', 'true');
    tpl.innerHTML = SVG[name] ?? ''; // constant markup only
    iconTemplates.set(name, tpl);
  }
  const svg = tpl.cloneNode(true) as SVGSVGElement;
  svg.setAttribute('class', cls);
  return svg;
}

/** Obsidian callout aliases → canonical kind (drives colour + icon). */
export const CALLOUTS: Record<string, { kind: string; icon: string }> = {};
const defineCallout = (kind: string, ic: string, aliases: string[]) => [kind, ...aliases].forEach((a) => (CALLOUTS[a] = { kind, icon: ic }));
defineCallout('note', 'pencil', []);
defineCallout('abstract', 'clipboard', ['summary', 'tldr']);
defineCallout('info', 'info', []);
defineCallout('todo', 'todo', []);
defineCallout('tip', 'flame', ['hint', 'important']);
defineCallout('success', 'check', ['check', 'done']);
defineCallout('question', 'help', ['help', 'faq']);
defineCallout('warning', 'warning', ['caution', 'attention']);
defineCallout('failure', 'x', ['fail', 'missing']);
defineCallout('danger', 'zap', ['error']);
defineCallout('bug', 'bug', []);
defineCallout('example', 'list', []);
defineCallout('quote', 'quote', ['cite']);

export function calloutInfo(type: string) {
  return CALLOUTS[type.toLowerCase()] ?? CALLOUTS.note;
}

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = `se-bullet se-bullet-d${this.depth % 3}`;
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'se-task' + (this.checked ? ' se-task-checked' : '');
    wrap.setAttribute('role', 'checkbox');
    wrap.setAttribute('aria-checked', String(this.checked));
    wrap.setAttribute('aria-label', 'Toggle task');
    wrap.appendChild(icon('check', 'se-task-check'));
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const spec = toggleTaskAt(view.state, view.posAtDOM(wrap));
      if (spec) view.dispatch(spec);
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'se-hr';
    return s;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string | null,
    readonly alt: string,
    readonly width: number | null,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt && o.width === this.width;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'se-image';
    if (!this.src) {
      wrap.classList.add('se-image-missing');
      wrap.append(icon('image'), document.createTextNode(` ${this.alt || 'image not found'}`));
      return wrap;
    }
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    img.addEventListener('error', () => {
      wrap.classList.add('se-image-missing');
      wrap.replaceChildren(icon('image'), document.createTextNode(` ${this.alt || this.src}`));
    });
    wrap.appendChild(img);
    return wrap;
  }
  get estimatedHeight() {
    return this.src ? 200 : -1;
  }
}

// KaTeX is ~300KB: load on first math render only.
type Katex = { render(tex: string, el: HTMLElement, opts: Record<string, unknown>): void };
let katexLib: Katex | null = null;
let katexLoad: Promise<Katex> | null = null;
export function loadKatex(): Promise<Katex> {
  return (katexLoad ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => (katexLib = ((m as { default?: Katex }).default ?? m) as Katex)));
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  private renderInto(el: HTMLElement, k: Katex) {
    try {
      k.render(this.tex, el, { displayMode: this.display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore' });
    } catch (err) {
      el.textContent = this.tex;
      el.classList.add('se-math-error');
      el.title = String((err as Error).message ?? err);
    }
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'se-math se-math-block' : 'se-math se-math-inline';
    if (katexLib) this.renderInto(el, katexLib);
    else {
      el.textContent = this.tex;
      el.classList.add('se-math-loading');
      void loadKatex().then((k) => {
        el.classList.remove('se-math-loading');
        el.textContent = '';
        this.renderInto(el, k);
        view.requestMeasure();
      });
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Language label + copy button (+ "Run in terminal" for shell code in the desktop app) pinned to the top-right of a fenced code block.
 *  With {{variables}}: copy / run use the resolved text, an OS hint and "Copy / Run for targets…" (../variables). */
export class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly info = '',
    readonly vars: CodeHeaderVars | null = null,
  ) {
    super();
  }
  eq(o: CodeHeaderWidget) {
    return o.lang === this.lang && o.info === this.info && o.vars?.os === this.vars?.os && o.vars?.multi === this.vars?.multi;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'se-cb-header';
    wrap.contentEditable = 'false';
    if (this.vars?.os) {
      const os = document.createElement('span');
      os.className = 'se-cb-os';
      os.title = `${this.vars.os}: check the command fits the target's OS`;
      os.append(icon('warning'), document.createTextNode(this.vars.os));
      wrap.appendChild(os);
    }
    if (this.lang) {
      const label = document.createElement('span');
      label.className = 'se-cb-lang';
      label.textContent = this.lang;
      wrap.appendChild(label);
    }
    const button = (cls: string, title: string, ic: string, onClick: (pos: number, code: string) => void) => {
      const b = document.createElement('button');
      b.className = cls;
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.appendChild(icon(ic));
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = view.posAtDOM(wrap);
        const code = codeAt(view, pos);
        if (code != null) onClick(pos, code);
      });
      return b;
    };
    const btn = button('se-cb-copy', 'Copy code', 'copy', (pos, code) => {
      const done = () => {
        btn.classList.add('se-copied');
        btn.replaceChildren(icon('check'));
        setTimeout(() => {
          btn.classList.remove('se-copied');
          btn.replaceChildren(icon('copy'));
        }, 1200);
      };
      // Placeholders are resolved first (may ask for missing values); null = nothing to resolve.
      void codeAction('copy', view, pos, code).then((r) => {
        if (r !== null) return void (r && done());
        const text = copyableCode(code);
        navigator.clipboard?.writeText(text).then(done, () => {
          fallbackCopy(text);
          done();
        }) ?? (fallbackCopy(text), done());
      });
    });
    if (this.vars?.multi) {
      wrap.appendChild(
        button('se-cb-multi', 'Copy / Run for targets…', 'crosshair', (pos, code) => void app.variables?.forTargets(code, { path: view.state.facet(docPath), info: this.info || this.lang })),
      );
    }
    const run = app.runInTerminal;
    if (run && isRunnableFence(this.lang)) {
      // Pastes into the terminal; never presses Enter unless the user's setting says so.
      wrap.appendChild(
        button('se-cb-run', 'Run in terminal', 'terminal', (pos, code) => {
          if (code) void codeAction('run', view, pos, code).then((r) => r === null && run(code, { lang: this.lang }));
        }),
      );
    }
    wrap.appendChild(btn);
    return wrap;
  }
  ignoreEvent(e: Event) {
    return !!(e.target as HTMLElement).closest?.('button');
  }
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {}
  ta.remove();
}

/** Text between the fences of the code block containing pos. */
export function codeAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode') {
      const doc = view.state.doc;
      const first = doc.lineAt(n.from);
      const last = doc.lineAt(n.to);
      const marks = n.getChildren('CodeMark');
      const closed = marks.length >= 2 && last.number > first.number;
      const endLine = closed ? last.number - 1 : last.number;
      if (endLine < first.number + 1) return '';
      return doc.sliceString(doc.line(first.number + 1).from, doc.line(endLine).to);
    }
  }
  // posAtDOM can land at the line end; retry from the line start.
  const line = view.state.doc.lineAt(pos);
  if (pos !== line.from) return codeAt(view, line.from);
  return null;
}

export class CalloutIconWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly defaultTitle: string | null,
  ) {
    super();
  }
  eq(o: CalloutIconWidget) {
    return o.type === this.type && o.defaultTitle === this.defaultTitle;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'se-callout-icon';
    wrap.appendChild(icon(calloutInfo(this.type).icon));
    if (this.defaultTitle) {
      const t = document.createElement('span');
      t.className = 'se-callout-default-title';
      t.textContent = this.defaultTitle;
      wrap.appendChild(t);
    }
    return wrap;
  }
}

export class CalloutFoldWidget extends WidgetType {
  constructor(
    readonly folded: boolean,
    readonly onToggle: (view: EditorView, pos: number) => void,
  ) {
    super();
  }
  eq(o: CalloutFoldWidget) {
    return o.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const btn = document.createElement('span');
    btn.className = 'se-callout-fold' + (this.folded ? ' se-folded' : '');
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', this.folded ? 'Expand callout' : 'Collapse callout');
    btn.appendChild(icon('chevron'));
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onToggle(view, view.posAtDOM(btn));
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

/** Rendered GFM table; clicking a cell puts the cursor into that cell of the source. */
export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'se-table-wrap';
    const table = document.createElement('table');
    table.className = 'se-table';
    const lines = this.source.split('\n');
    const aligns = lines.length > 1 && isDelimiterRow(lines[1]) ? splitRow(lines[1]).cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '')) : [];
    const cols = Math.max(...lines.map((l, i) => (i === 1 ? 0 : splitRow(l).cells.length)));
    let offset = 0;
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    lines.forEach((line, i) => {
      const lineOffset = offset;
      offset += line.length + 1;
      if (i === 1) return;
      const tr = document.createElement('tr');
      const cells = splitRow(line).cells;
      const ranges = cellRanges(line);
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement(i === 0 ? 'th' : 'td');
        if (aligns[c]) cell.style.textAlign = aligns[c];
        renderInline(cells[c] ?? '', cell);
        const r = ranges[c];
        cell.dataset.offset = String(lineOffset + (r ? r.to : line.length));
        tr.appendChild(cell);
      }
      (i === 0 ? thead : tbody).appendChild(tr);
    });
    table.append(thead, tbody);
    wrap.appendChild(table);
    wrap.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest<HTMLElement>('a.se-mdlink');
      if (link && followLinkElement(view, link, e)) return;
      const cell = target.closest<HTMLElement>('td,th');
      e.preventDefault();
      const base = view.posAtDOM(wrap);
      const pos = Math.min(view.state.doc.length, base + (cell ? Number(cell.dataset.offset) : 0));
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: false, userEvent: 'select.pointer' });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(e: Event) {
    return e.type === 'mousedown';
  }
  get estimatedHeight() {
    return this.source.split('\n').length * 34;
  }
}

/** Fold arrow in the left margin of headings (Obsidian style), shown on hover or when folded. */
export class HeadingFoldWidget extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(o: HeadingFoldWidget) {
    return o.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = 'se-heading-fold' + (this.folded ? ' se-folded' : '');
    el.setAttribute('aria-hidden', 'true');
    el.appendChild(icon('chevron'));
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const line = view.state.doc.lineAt(view.posAtDOM(el));
      let existing: { from: number; to: number } | null = null;
      foldedRanges(view.state).between(line.to, line.to + 1, (from, to) => {
        if (from === line.to) existing = { from, to };
      });
      if (existing) view.dispatch({ effects: unfoldEffect.of(existing) });
      else {
        const range = foldable(view.state, line.from, line.to);
        if (range) view.dispatch({ effects: foldEffect.of(range) });
      }
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * Rendered ```mermaid block. Rendering is delegated to the preview module's enhancer (lazy import) so
 * both views share one serialised mermaid instance + theme; falls back to the source when unavailable.
 */
export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'se-mermaid-wrap';
    const el = document.createElement('div');
    el.className = 'se-mermaid';
    el.dataset.src = this.source;
    // The note's remote-media policy (as for live-mode images): without it, a diagram that loads anything is not drawn.
    if (remoteAllowed(view.state.facet(docPath))) el.dataset.remote = '';
    const pending = document.createElement('pre');
    pending.className = 'se-mermaid-pending';
    pending.textContent = this.source;
    el.appendChild(pending);
    wrap.appendChild(el);
    void import('../preview/enhance')
      .then((m) => (typeof m.enhanceAll === 'function' ? m.enhanceAll(wrap, { dark: typeof m.isDark === 'function' ? m.isDark() : true }) : undefined))
      .catch(() => {})
      .then(() => view.requestMeasure());
    return wrap;
  }
  get estimatedHeight() {
    return 220;
  }
}

/**
 * Re-renders diagrams when the theme changes (html[data-theme], or the OS scheme under "system"):
 * mermaid bakes colours into the SVG, so CSS variables alone can't re-theme it.
 */
export const mermaidRetheme = ViewPlugin.fromClass(
  class {
    private mo: MutationObserver | null = null;
    private mq: MediaQueryList | null = null;
    private queued = false;
    constructor(readonly view: EditorView) {
      if (typeof MutationObserver !== 'undefined') {
        this.mo = new MutationObserver(this.schedule);
        this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
      this.mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
      this.mq?.addEventListener?.('change', this.schedule);
    }
    schedule = () => {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => {
        this.queued = false;
        void this.retheme();
      });
    };
    async retheme() {
      if (!this.view.dom.querySelector('.se-mermaid[data-done]')) return;
      const m = await import('../preview/enhance');
      const mode = m.isDark() ? 'dark' : 'light';
      // Only each diagram's own container: enhanceAll would otherwise "upgrade" the editor's math widgets too.
      const parents = new Set<HTMLElement>();
      for (const el of this.view.dom.querySelectorAll<HTMLElement>('.se-mermaid[data-done]')) {
        if (el.dataset.done === mode || !el.parentElement) continue;
        delete el.dataset.done; // data-src keeps the diagram source
        parents.add(el.parentElement);
      }
      if (!parents.size) return;
      await Promise.all([...parents].map((p) => m.enhanceAll(p, { dark: mode === 'dark' })));
      this.view.requestMeasure();
    }
    destroy() {
      this.mo?.disconnect();
      this.mq?.removeEventListener?.('change', this.schedule);
    }
  },
);
