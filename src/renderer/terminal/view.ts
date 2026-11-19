// xterm.js-backed TerminalView (lazy chunk: xterm + addons load with the first terminal).
import { Terminal, type IBufferLine, type ILink, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { findPathCandidates } from './links';
import { terminalKeyAction } from './keys';
import { writeClipboard } from './clipboard';
import type { TermTheme } from './theme';
import type { FindOptions, GpuMode, Off, TerminalView, TerminalViewOptions } from './types';

/** Software WebGL (SwiftShader, llvmpipe, Microsoft Basic Render) draws slower than the DOM renderer. */
export const isSoftwareGl = (renderer: string) => /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i.test(renderer);

let hwGl: boolean | null = null;
/** Is WebGL2 hardware-accelerated here? (checked once) */
export function hardwareWebgl(): boolean {
  if (hwGl !== null) return hwGl;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const r = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    hwGl = !!gl && !!r && !isSoftwareGl(r);
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // give the probe context back right away
  } catch {
    hwGl = false;
  }
  return hwGl;
}

const idle = (fn: () => void) => ((globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 50)))(fn, { timeout: 1500 });

/** Line text + which cell each UTF-16 unit came from (wide CJK / emoji cells take two columns). */
export function lineCells(line: Pick<IBufferLine, 'length' | 'getCell'>): { text: string; cellOf: number[] } {
  let text = '';
  const cellOf: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue; // second half of a wide char
    const ch = cell.getChars() || ' ';
    for (let i = 0; i < ch.length; i++) cellOf.push(x);
    text += ch;
  }
  return { text, cellOf };
}

const xtermTheme = (t: TermTheme): ITheme => {
  const { matchBackground: _m, activeMatchBackground: _a, ...rest } = t;
  return rest;
};

const modClick = (e: MouseEvent, os: string) => (os === 'darwin' ? e.metaKey : e.ctrlKey);


/**
 * Idle warm-up: open (and dispose) one hidden terminal, so the first real one does not pay for the first
 * font measurement, style recalc of xterm.css and cold JIT (~15 ms → ~5 ms on the open path).
 */
export function warmXterm(o: { fontFamily: string; fontSize: number }): void {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:-10000px;top:0;width:480px;height:160px;visibility:hidden;pointer-events:none';
  document.body.append(el);
  const t = new Terminal({ fontFamily: o.fontFamily, fontSize: o.fontSize, lineHeight: 1.15, scrollback: 0 });
  t.open(el);
  t.write('\x1b[1;32mwarm\x1b[0m $ ', () =>
    setTimeout(() => {
      t.dispose();
      el.remove();
    }, 0),
  );
}

export function createXtermView(o: TerminalViewOptions): TerminalView {
  const element = document.createElement('div');
  element.className = 'se-term-view';
  const term = new Terminal({
    allowProposedApi: true, // search decorations (match highlighting + counts)
    cursorBlink: true,
    cursorInactiveStyle: 'outline',
    fontFamily: o.fontFamily,
    fontSize: o.fontSize,
    lineHeight: 1.15,
    scrollback: o.scrollback,
    theme: o.theme ? xtermTheme(o.theme) : undefined,
    minimumContrastRatio: 4.5, // keeps "white" output readable on the light theme
    drawBoldTextInBrightColors: true,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: false, // right-click opens our menu
    // ConPTY reflow heuristics (xterm.js needs the backend + build to get wrapped lines right).
    windowsPty: o.os === 'win32' ? { backend: 'conpty', buildNumber: o.windowsBuild } : undefined,
    // OSC 8 hyperlinks: web/mail only (no file:, no custom protocol handlers).
    linkHandler: { activate: (e, uri) => modClick(e, o.os) && o.openUrl(uri), allowNonHttpProtocols: false },
  });
  const fitAddon = new FitAddon();
  const search = new SearchAddon({ highlightLimit: 2000 });
  term.loadAddon(fitAddon);
  term.loadAddon(search);
  let theme = o.theme;
  let linkShown = false;
  const hint = (show: boolean) => {
    linkShown = show;
    element.title = show ? `${o.os === 'darwin' ? 'Cmd' : 'Ctrl'}+click to open` : '';
  };
  term.loadAddon(new WebLinksAddon((e, uri) => modClick(e, o.os) && o.openUrl(uri), { hover: () => hint(true), leave: () => hint(false) }));

  // Workspace files named in the output: `src/a.ts:12:3` → Ctrl+click opens it at that line.
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return cb(undefined);
      const { text, cellOf } = lineCells(line);
      const links: ILink[] = [];
      for (const c of findPathCandidates(text)) {
        const path = o.resolvePath(c.path);
        if (!path || cellOf[c.start] === undefined) continue;
        const target = { path, line: c.line, col: c.col };
        links.push({
          range: { start: { x: cellOf[c.start] + 1, y }, end: { x: cellOf[c.end - 1] + 1, y } },
          text: text.slice(c.start, c.end),
          decorations: { pointerCursor: true, underline: true },
          activate: (e) => modClick(e, o.os) && o.openPath(target),
          hover: () => hint(true),
          leave: () => hint(false),
        });
      }
      cb(links.length ? links : undefined);
    },
  });

  const cleanups: Array<() => void> = [];

  // WebGL renderer: switched on after the terminal is up (never on the open path), off again on context loss.
  let gpu: GpuMode = o.gpu ?? 'auto';
  let webgl: { dispose(): void } | null = null;
  let disposed = false;
  async function applyGpu() {
    const want = opened && !disposed && (gpu === 'on' || (gpu === 'auto' && hardwareWebgl()));
    if (!want) {
      webgl?.dispose();
      webgl = null;
      return;
    }
    if (webgl) return;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      if (disposed || webgl || !(gpu === 'on' || (gpu === 'auto' && hardwareWebgl()))) return;
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (webgl === addon) webgl = null; // xterm falls back to its DOM renderer
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      webgl = null; // no WebGL2 here: stay on the DOM renderer
    }
  }

  const view: TerminalView = {
    element,
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    get bracketedPaste() {
      return term.modes.bracketedPasteMode;
    },
    write: (data, done) => term.write(data, done),
    paste,
    fit,
    focus: () => {
      ensureOpen();
      term.focus();
    },
    hasFocus: () => !!element.contains(document.activeElement),
    hasSelection: () => term.hasSelection(),
    getSelection: () => term.getSelection(),
    selectAll: () => term.selectAll(),
    clearSelection: () => term.clearSelection(),
    clear: () => term.clear(),
    allText() {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < b.length; y++) {
        const line = b.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return lines.join('\n');
    },
    async copySelection() {
      const text = term.getSelection();
      if (!text) return false;
      const ok = await writeClipboard(text);
      if (!ok) o.onClipboardError('copy');
      return ok;
    },
    async pasteFromClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (text) paste(text);
        return true;
      } catch {
        o.onClipboardError('paste');
        return false;
      }
    },
    findNext: (q, f) => search.findNext(q, searchOpts(f)),
    findPrevious: (q, f) => search.findPrevious(q, searchOpts(f)),
    clearFind: () => search.clearDecorations(),
    onFindResults: (cb) => sub(search.onDidChangeResults((r) => cb({ index: r.resultIndex, count: r.resultCount }))),
    setOptions(p) {
      if (p.fontSize !== undefined) term.options.fontSize = p.fontSize;
      if (p.fontFamily !== undefined) term.options.fontFamily = p.fontFamily;
      if (p.scrollback !== undefined) term.options.scrollback = p.scrollback;
      if (p.theme) {
        theme = p.theme;
        term.options.theme = xtermTheme(p.theme);
      }
      if (p.windowsBuild !== undefined) term.options.windowsPty = { backend: 'conpty', buildNumber: p.windowsBuild };
      if (p.gpu !== undefined && p.gpu !== gpu) {
        gpu = p.gpu;
        void applyGpu();
      }
      if (p.fontSize !== undefined || p.fontFamily !== undefined) fit();
    },
    renderer: () => (webgl ? 'webgl' : 'dom'),
    setSize: (cols, rows) => term.resize(Math.max(2, cols), Math.max(1, rows)),
    cellSize() {
      // What FitAddon itself reads: the renderer's measured cell (private API, hence the guard).
      const c = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
      return c && c.width > 0 && c.height > 0 ? { width: c.width, height: c.height } : null;
    },
    onInput: (cb) => sub(term.onData(cb)),
    onResize: (cb) => sub(term.onResize(cb)),
    onTitle: (cb) => sub(term.onTitleChange(cb)),
    dispose() {
      disposed = true;
      cleanups.splice(0).forEach((f) => f());
      webgl = null; // disposed with the terminal
      ro?.disconnect();
      cancelAnimationFrame(raf);
      term.dispose();
      element.remove();
    },
  };

  /**
   * What xterm's own paste() does (\n → \r, bracketed paste when the shell asked for it), but usable
   * before the view is opened (Run in terminal into a hidden panel). Embedded bracket markers are
   * dropped: pasted text must never be able to end the bracket early and run as typed input.
   */
  function paste(text: string) {
    const t = text.replace(/\r?\n/g, '\r').replace(/\x1b\[20[01]~/g, '');
    if (t) term.input(term.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t, true);
  }

  function searchOpts(f: FindOptions = {}) {
    return {
      caseSensitive: !!f.caseSensitive,
      regex: !!f.regex,
      wholeWord: !!f.wholeWord,
      decorations: theme
        ? { matchBackground: theme.matchBackground, activeMatchBackground: theme.activeMatchBackground, matchOverviewRuler: theme.matchBackground, activeMatchColorOverviewRuler: theme.activeMatchBackground }
        : undefined,
    };
  }

  term.attachCustomKeyEventHandler((e) => {
    const action = terminalKeyAction(e, { os: o.os, hasSelection: term.hasSelection() });
    if (action === null) return true;
    if (e.type === 'keydown') {
      e.preventDefault();
      if (action === 'copy') void view.copySelection().then((ok) => ok && o.os === 'win32' && !e.shiftKey && term.clearSelection());
      else if (action === 'paste') void view.pasteFromClipboard();
      else if (action === 'find') o.onFind();
      else if (action === 'selectAll') term.selectAll();
      else if (action === 'clear') term.clear();
    }
    return false; // xterm must not also send the key to the shell
  });

  // Opened lazily: xterm measures the font when it opens, which needs the element in the document.
  let opened = false;
  function ensureOpen() {
    if (opened || !element.isConnected) return;
    opened = true;
    term.open(element);
    watchRestingMouse();
    idle(() => void applyGpu());
  }

  /**
   * xterm caches link-provider answers per row and asks again only when the mouse changes rows (or a link
   * was already shown there). So a path printed under a resting mouse, or while the mouse was outside,
   * stayed unlinked until you left the row and came back. Replay that row change when the row under the
   * mouse re-renders, and on re-entry. Not bubbling: only the screen's own listeners (link detection,
   * cursor style) see it, never mouse reporting or drag selection.
   */
  function watchRestingMouse() {
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    let at: { x: number; y: number } | null = null;
    const rowAt = (y: number) => {
      const r = screen.getBoundingClientRect();
      return Math.floor((y - r.top) / (r.height / term.rows));
    };
    const reask = (row: number) => {
      if (!at || linkShown || disposed || row < 0 || row >= term.rows || term.modes.mouseTrackingMode !== 'none') return;
      const h = screen.getBoundingClientRect().height / term.rows;
      for (const y of [at.y + (row > 0 ? -h : h), at.y]) screen.dispatchEvent(new MouseEvent('mousemove', { clientX: at.x, clientY: y }));
    };
    screen.addEventListener('mousemove', (e) => {
      if (!e.isTrusted) return;
      const back = !at;
      at = { x: e.clientX, y: e.clientY };
      if (back) reask(rowAt(at.y)); // runs after xterm's own handler: only acts if that found no link
    });
    screen.addEventListener('mouseleave', () => (at = null));
    const sub = term.onRender(({ start, end }) => {
      if (!at) return;
      const row = rowAt(at.y);
      if (row >= start && row <= end) reask(row);
    });
    cleanups.push(() => sub.dispose());
  }

  let raf = 0;
  function fit() {
    ensureOpen();
    if (!opened || !element.clientWidth || !element.clientHeight) return; // hidden panel: keep the old size
    const d = fitAddon.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
    const cols = Math.max(2, d.cols);
    const rows = Math.max(1, d.rows);
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (cancelAnimationFrame(raf), (raf = requestAnimationFrame(fit)))) : null;
  ro?.observe(element);

  return view;
}

function sub(d: { dispose(): void }): Off {
  return () => d.dispose();
}
