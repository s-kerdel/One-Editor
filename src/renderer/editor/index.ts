// Editor module (CodeMirror 6). One EditorView; one EditorState per open file so every tab keeps
// its own undo history, selection and scroll position. Markdown gets Live Preview / source mode,
// smart list/table editing and completion; code files get lazy grammars, gutters and code tooling.
import './editor.css';
import { EditorState, Compartment, EditorSelection, Prec, StateEffect, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, highlightSpecialChars, placeholder, type Command } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands';
import { indentOnInput, bracketMatching, foldGutter, codeFolding, foldKeymap, indentUnit, getIndentUnit } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, setSearchQuery } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import type { Settings } from '@shared/api';
import { isMarkdown } from '@shared/paths';
import type { EditorController, RevealTarget } from '../app/app';
import { markdownSupport, markdownSupportLite, HUGE_MARKDOWN } from './syntax';
import { syntaxTheme, chromeTheme } from './theme';
import { livePreview, sourceMode, frontmatterStyling, refreshLive } from './live';
import { markdownKeys, commonKeymap } from './mdkeys';
import { autoRenumber } from './lists';
import { markdownCompletionSources } from './complete';
import { docPath } from './host';
import { linkHandlers } from './links';
import { pagePreview } from './hover';
import { loadLanguage, loadedLanguage, languageDataFallback, indentGuides, detectIndent, autoLanguage } from './code';
import { languageById } from '@shared/languages';

export { detectIndent };
import { searchHighlighter, setHighlightQuery, toSearchQuery, highlightQueryField } from './search-highlight';
import { icon } from './widgets';
import { installEditorIntegration, completionHost } from './integration';
import { registerEditorCommands } from './palette';
import { slashMenu } from './slash';
import { pasteAndDrop } from './paste';
import { frontmatterBody } from './frontmatter';
import { FORMAT_TOOLBAR } from './toolbar';
import { editorContextMenu } from './context-menu';
import { focusMode, typewriter } from './focus';
import { gitEditor } from '../git/gutter';
import { variableChips, variableCompletion, variablesEditor } from '../variables/cm';
import { whitespaceEditor } from '../whitespace/cm';
import { parseAhead } from './parse-ahead';
import { gotoDefinition } from './gotodef';
// Git change navigation for the palette (../git/index loads them from this chunk: no extra gutter chunk).
export { nextChange, previousChange, peekChangeAtCursor, revertChangeAtCursor } from '../git/gutter';

interface DocRecord {
  state: EditorState;
  scroll: StateEffect<unknown> | null;
}

type Mode = 'live' | 'source';

/** Tab in code: insert one indent unit at the cursor, or indent the selected lines. */
const indentOrInsert: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  const unit = state.facet(indentUnit);
  view.dispatch(
    state.changeByRange((r) => {
      let insert = unit;
      if (unit !== '\t') {
        const col = r.head - state.doc.lineAt(r.head).from;
        const size = getIndentUnit(state);
        insert = ' '.repeat(size - (col % size) || size);
      }
      return { changes: { from: r.head, insert }, range: EditorSelection.cursor(r.head + insert.length) };
    }),
    { userEvent: 'input.indent', scrollIntoView: true },
  );
  return true;
};

// CodeMirror owns view.dom's class list (setState resets it), so the host class must be an attribute facet.
const BASE_ATTRS = EditorView.editorAttributes.of({ class: 'se-editor' });

const foldMarker = (open: boolean) => {
  const el = icon('chevron', `se-fold-marker ${open ? 'se-fold-open' : 'se-fold-closed'}`);
  return el as unknown as HTMLElement;
};

export function createEditor(parent: HTMLElement): EditorController {
  const docs = new Map<string, DocRecord>();
  const changeCbs = new Set<(p: string, c: string) => void>();
  const cursorCbs = new Set<(edited?: boolean) => void>();
  const scrollCbs = new Set<(l: number) => void>();
  const langCbs = new Set<(p: string) => void>();
  /** Per-doc language overrides (`languages.ts` ids); absent = by extension. */
  const langOverride = new Map<string, string>();
  /** Markdown editing (live preview, toolbar, …) only for .md files whose language isn't overridden. */
  const isMdView = (path: string) => isMarkdown(path) && !langOverride.has(path);

  const langComp = new Compartment();
  const pathComp = new Compartment();
  const wrapComp = new Compartment();
  const gutterComp = new Compartment();
  const modeComp = new Compartment();
  const attrsComp = new Compartment();
  const toolbarComp = new Compartment();
  const writingComp = new Compartment();
  const gitComp = new Compartment();

  /** While set, `of()` records each compartment's content (a full reconfigure keeps old contents otherwise). */
  let collected: Map<Compartment, Extension> | null = null;
  const of = (c: Compartment, ext: Extension) => {
    collected?.set(c, ext);
    return c.of(ext);
  };

  let current: string | null = null;
  let settings: Settings | null = null;
  let mode: Mode = 'live';

  // Shared extension instances so compartment contents can be compared by identity.
  const WRAP: Extension = EditorView.lineWrapping;
  const NO_WRAP: Extension = [];
  // The gutter class lets CSS keep the numbers next to the centred markdown text column.
  const MD_GUTTERS: Extension = [lineNumbers(), foldGutter({ markerDOM: foldMarker }), highlightActiveLineGutter(), EditorView.editorAttributes.of({ class: 'se-gutter-on' })];
  const CODE_GUTTERS: Extension = [lineNumbers(), foldGutter({ markerDOM: foldMarker }), highlightActiveLineGutter()];
  const NONE: Extension = [];
  const NO_LANG: Extension = [];
  const writingExts = new Map<string, Extension>();
  /** Markdown line numbers: source + split only (never live / reading), unless switched off. */
  const mdGutter = () => (mode === 'source' && settings?.markdownLineNumbers !== false ? MD_GUTTERS : NONE);
  const mdToolbar = () => (mode === 'live' && settings?.formatToolbar !== false ? FORMAT_TOOLBAR : NONE);
  const writing = () => {
    const f = !!settings?.['editor.focusMode'];
    const t = !!settings?.['editor.typewriter'];
    const k = `${f}${t}`;
    let e = writingExts.get(k);
    if (!e) writingExts.set(k, (e = [f ? focusMode : [], t ? typewriter : []]));
    return e;
  };
  // Git change bars + conflict highlighting (../git). Markdown gets the bar column only once the note has a
  // HEAD version, so plain folders and untracked notes keep their exact layout.
  const docPathOf = (s: EditorState) => s.facet(docPath);
  const GIT_MD = gitEditor({ path: docPathOf, whenBase: true });
  const GIT_CODE = gitEditor({ path: docPathOf });
  const gitExt = (md: boolean) => (settings?.['git.enabled'] === false || settings?.['git.changeBars'] === false ? NONE : md ? GIT_MD : GIT_CODE);
  // {{variables}} chips are live-only: source mode / split's source pane show the raw placeholders.
  const LIVE = [livePreview(), variableChips()];
  const SOURCE = sourceMode();
  const attrCache = new Map<string, Extension>();
  const attrs = (spell: boolean) => {
    const k = String(spell);
    let e = attrCache.get(k);
    if (!e) attrCache.set(k, (e = EditorView.contentAttributes.of({ spellcheck: String(spell), autocorrect: spell ? 'on' : 'off', autocapitalize: 'off' })));
    return e;
  };

  // Change notifications: immediate for normal docs. Huge docs use a leading+trailing throttle: the
  // first edit reports at once (dirty flag / autosave stay correct), later ones are coalesced because
  // every listener (search index, outline, …) re-reads the whole text.
  let pending: { path: string; timer: ReturnType<typeof setTimeout>; dirty: boolean } | null = null;
  const emitChange = (p: string) => {
    const text = p === current ? view.state.doc.toString() : docs.get(p)?.state.doc.toString();
    if (text !== undefined) changeCbs.forEach((cb) => cb(p, text));
  };
  const flushChange = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { path: p, dirty } = pending;
    pending = null;
    if (dirty) emitChange(p);
  };
  const notifyChange = (path: string, state: EditorState) => {
    if (pending && pending.path !== path) flushChange();
    if (state.doc.length < 500_000) {
      const text = state.doc.toString();
      changeCbs.forEach((cb) => cb(path, text));
      return;
    }
    if (pending) {
      pending.dirty = true;
      return;
    }
    emitChange(path);
    pending = { path, dirty: false, timer: setTimeout(flushChange, Math.min(1000, 150 + state.doc.length / 10_000)) };
  };

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && current) notifyChange(current, u.state);
    if (u.selectionSet || u.docChanged) cursorCbs.forEach((cb) => cb(u.docChanged));
  });

  // Right-click menu (shell context menu); markdown items only in markdown views.
  const contextMenu = editorContextMenu((v) => isMdView(v.state.facet(docPath)));

  const commonExtensions = (path: string): Extension[] => [
    BASE_ATTRS,
    of(pathComp, docPath.of(path)),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    highlightSpecialChars(),
    indentOnInput(),
    syntaxTheme,
    chromeTheme,
    search({ top: true }),
    searchHighlighter,
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey && e.button === 0 }),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey),
    of(wrapComp, settings?.wordWrap === false ? NO_WRAP : WRAP),
    of(attrsComp, attrs(!!settings?.spellcheck && isMdView(path))),
    updateListener,
    contextMenu,
    whitespaceEditor(), // trims pasted terminal padding; Ctrl+Shift+V = exactly as copied
    codeFolding({ placeholderText: '…' }),
    parseAhead, // big docs: finish the syntax tree in idle time, so typing after a jump stays light
    Prec.high(keymap.of(commonKeymap)),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
    EditorState.tabSize.of(4),
  ];

  const markdownExtensions = (path: string, content: string): Extension[] => {
    const md = content.length > HUGE_MARKDOWN ? markdownSupportLite() : markdownSupport();
    return [
      ...commonExtensions(path),
      of(langComp, md),
      // Obsidian-style %% comments for Mod-/; prose-friendly auto-pairs (no quotes).
      md.language.data.of({ closeBrackets: { brackets: ['(', '[', '{', '`'] }, commentTokens: { block: { open: '%%', close: '%%' } } }),
      closeBrackets(),
      markdownKeys(),
      autoRenumber,
      // Before autocompletion: both keymaps are Prec.highest and the menu must win Enter/Escape/arrows.
      slashMenu(),
      autocompletion({ override: [...markdownCompletionSources(completionHost), variableCompletion], icons: false, maxRenderedOptions: 60 }),
      of(modeComp, mode === 'live' ? LIVE : SOURCE),
      of(gutterComp, mdGutter()),
      of(gitComp, gitExt(true)),
      of(toolbarComp, mdToolbar()),
      of(writingComp, writing()),
      frontmatterStyling,
      linkHandlers,
      pagePreview,
      pasteAndDrop(),
      variablesEditor(),
      placeholder('Start writing…'),
      EditorView.editorAttributes.of({ class: 'se-md' }),
    ];
  };

  const codeExtensions = (path: string, content: string): Extension[] => [
    ...commonExtensions(path),
    of(langComp, loadedLanguage(path, langOverride.get(path)) ?? NO_LANG),
    languageDataFallback(path, langOverride.get(path)),
    indentUnit.of(detectIndent(content)),
    closeBrackets(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches({ minSelectionLength: 2 }),
    autocompletion({ maxRenderedOptions: 60 }),
    of(gutterComp, CODE_GUTTERS),
    of(gitComp, gitExt(false)),
    indentGuides,
    gotoDefinition, // Ctrl/Cmd+click, F12 / Shift+F12 (the resolver is a lazy chunk)
    Prec.high(keymap.of([{ key: 'Tab', run: indentOrInsert, shift: indentLess }])),
    EditorView.editorAttributes.of({ class: 'se-codefile' }),
  ];

  /** A freshly opened note starts below its frontmatter (typing at offset 0 would break the YAML fence). */
  const initialSelection = (path: string, content: string): EditorSelection | undefined => {
    if (!isMarkdown(path) || !content.startsWith('---')) return undefined;
    const fm = frontmatterBody(content.slice(0, 256 * 1024));
    if (!fm) return undefined;
    const close = content.indexOf('\n', fm.to);
    return EditorSelection.single(close < 0 ? content.length : close + 1);
  };

  const extensionsFor = (path: string, content: string) => (isMdView(path) ? markdownExtensions(path, content) : codeExtensions(path, content));

  const createState = (path: string, content: string, selection?: EditorSelection) =>
    EditorState.create({
      doc: content,
      selection: selection ? EditorSelection.create(selection.ranges.map((r) => EditorSelection.range(Math.min(r.anchor, content.length), Math.min(r.head, content.length))), selection.mainIndex) : initialSelection(path, content),
      extensions: extensionsFor(path, content),
    });

  const emptyState = () => EditorState.create({ doc: '', extensions: [BASE_ATTRS, chromeTheme] });
  const view = new EditorView({ parent, state: emptyState() });

  /** Effects that bring a state's settings-dependent compartments in line with current settings. */
  const syncEffects = (state: EditorState, path: string): StateEffect<unknown>[] => {
    const fx: StateEffect<unknown>[] = [];
    const md = isMdView(path);
    const want: Array<[Compartment, Extension]> = [
      [wrapComp, settings?.wordWrap === false ? NO_WRAP : WRAP],
      [attrsComp, attrs(!!settings?.spellcheck && md)],
      [gitComp, gitExt(md)],
    ];
    if (md) {
      want.push([modeComp, mode === 'live' ? LIVE : SOURCE]);
      want.push([gutterComp, mdGutter()]);
      want.push([toolbarComp, mdToolbar()]);
      want.push([writingComp, writing()]);
    }
    for (const [c, ext] of want) if (c.get(state) !== undefined && c.get(state) !== ext) fx.push(c.reconfigure(ext));
    return fx;
  };

  /** Apply a transaction to a doc whether or not it's the visible one. */
  const applyTo = (path: string, spec: TransactionSpec) => {
    if (path === current) {
      view.dispatch(spec);
      return;
    }
    const rec = docs.get(path);
    if (!rec) return;
    const tr = rec.state.update(spec);
    rec.state = tr.state;
    if (tr.docChanged) notifyChange(path, tr.state);
  };

  const ensureLanguage = (path: string) => {
    if (isMdView(path)) return;
    const want = langOverride.get(path) ?? null;
    void loadLanguage(path, want).then((support) => {
      // A newer setLanguage (or a switch back to markdown) wins over this load.
      if (isMdView(path) || (langOverride.get(path) ?? null) !== want) return;
      const target = path === current ? view.state : docs.get(path)?.state;
      const ext = support ?? NO_LANG;
      if (!target || langComp.get(target) === ext) return;
      applyTo(path, { effects: langComp.reconfigure(ext) });
    });
  };

  const stash = () => {
    if (!current) return;
    const rec = docs.get(current);
    if (rec) {
      rec.state = view.state;
      rec.scroll = view.scrollSnapshot();
    }
  };

  // Exact monospace column width (px) for hanging indents of list items in live preview.
  let monoMeasured = false;
  const measureMono = () => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--font-mono);font-size:var(--editor-font-size);';
    probe.textContent = 'x'.repeat(40);
    parent.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 40;
    probe.remove();
    if (w > 0) {
      parent.style.setProperty('--se-mono-ch', `${w}px`);
      monoMeasured = true;
    }
  };
  void document.fonts?.ready.then(measureMono);

  const emitScroll = () => {
    if (!current) return;
    const line = ctrl.getTopLine();
    scrollCbs.forEach((cb) => cb(line));
  };
  view.scrollDOM.addEventListener('scroll', emitScroll, { passive: true });

  let highlight: ReturnType<typeof toSearchQuery> = null;

  const ctrl: EditorController = {
    open(path, content) {
      if (current === path && docs.has(path)) return;
      flushChange();
      stash();
      let rec = docs.get(path);
      if (!rec) {
        rec = { state: createState(path, content), scroll: null };
        docs.set(path, rec);
        ensureLanguage(path);
      }
      current = path;
      if (!monoMeasured) measureMono();
      view.setState(rec.state);
      const fx = syncEffects(view.state, path);
      if (view.state.field(highlightQueryField, false) !== highlight) fx.push(setHighlightQuery.of(highlight));
      if (rec.scroll) fx.push(rec.scroll);
      if (fx.length) view.dispatch({ effects: fx });
      cursorCbs.forEach((cb) => cb());
    },
    close(path) {
      if (pending?.path === path) flushChange();
      docs.delete(path);
      langOverride.delete(path); // the shell re-applies persisted overrides after open()
      if (current === path) {
        current = null;
        view.setState(emptyState());
      }
    },
    getContent(path) {
      const p = path ?? current;
      if (!p) return undefined;
      if (p === current) return view.state.doc.toString();
      return docs.get(p)?.state.doc.toString();
    },
    setContent(path, content, opts) {
      const rec = docs.get(path);
      if (!rec && path !== current) return;
      const state = path === current ? view.state : rec!.state;
      if (opts?.resetHistory) {
        const fresh = createState(path, content, state.selection);
        if (path === current) {
          const scroll = view.scrollSnapshot();
          view.setState(fresh);
          view.dispatch({ effects: [...syncEffects(fresh, path), scroll] });
          if (rec) rec.state = view.state;
        } else rec!.state = fresh;
        ensureLanguage(path);
        notifyChange(path, path === current ? view.state : rec!.state);
        return;
      }
      // Minimal diff so the cursor and scroll position stay put on external reloads.
      const old = state.doc.toString();
      if (old === content) return;
      let a = 0;
      const min = Math.min(old.length, content.length);
      while (a < min && old.charCodeAt(a) === content.charCodeAt(a)) a++;
      let b1 = old.length;
      let b2 = content.length;
      while (b1 > a && b2 > a && old.charCodeAt(b1 - 1) === content.charCodeAt(b2 - 1)) {
        b1--;
        b2--;
      }
      applyTo(path, { changes: { from: a, to: b1, insert: content.slice(a, b2) } });
    },
    rename(from, to) {
      const rec = docs.get(from);
      if (!rec) {
        if (current === from) current = to;
        return;
      }
      if (pending?.path === from) flushChange();
      docs.delete(from);
      const state = current === from ? view.state : rec.state;
      const wasMd = isMdView(from);
      const override = langOverride.get(from);
      langOverride.delete(from);
      if (override) langOverride.set(to, override);
      const kindChanged = wasMd !== isMdView(to);
      if (kindChanged) rec.state = createState(to, state.doc.toString(), state.selection);
      else rec.state = state.update({ effects: pathComp.reconfigure(docPath.of(to)) }).state;
      docs.set(to, rec);
      if (current === from) {
        current = to;
        const scroll = view.scrollSnapshot();
        view.setState(rec.state);
        view.dispatch({ effects: [...syncEffects(view.state, to), scroll] });
      }
      if (!isMdView(to)) {
        // Extension may have changed (a.txt → a.php): reload the grammar.
        if (!kindChanged && !override) applyTo(to, { effects: langComp.reconfigure(NO_LANG) });
        ensureLanguage(to);
      }
    },
    focus() {
      view.focus();
    },
    reveal(t: RevealTarget) {
      if (!current) return;
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(t.line + 1, 1), doc.lines));
      const from = Math.min(line.from + (t.col ?? 0), line.to);
      const to = Math.min(from + (t.length ?? 0), doc.length);
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }), userEvent: 'select.reveal' });
      view.focus();
    },
    setViewMode(m) {
      if (m === 'preview') return; // editor hidden by the shell; keep the current styling
      const next: Mode = m === 'live' ? 'live' : 'source';
      if (next === mode) return;
      mode = next;
      if (current && isMdView(current)) {
        const fx = syncEffects(view.state, current);
        if (fx.length) view.dispatch({ effects: [...fx, view.scrollSnapshot()] });
      }
    },
    applySettings(s) {
      settings = s;
      parent.style.setProperty('--editor-font-size', `${s.fontSize}px`);
      measureMono();
      ctrl.setViewMode(s.viewMode);
      if (current) {
        const fx = syncEffects(view.state, current);
        if (fx.length) view.dispatch({ effects: fx });
      }
    },
    getCursor() {
      const sel = view.state.selection.main;
      const line = view.state.doc.lineAt(sel.head);
      return { line: line.number - 1, col: sel.head - line.from, selectionLength: Math.abs(sel.to - sel.from) };
    },
    getTopLine() {
      const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
      const block = view.lineBlockAtHeight(Math.max(0, top));
      return view.state.doc.lineAt(block.from).number - 1;
    },
    scrollToLine(line) {
      const doc = view.state.doc;
      const l = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 0 }) });
    },
    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    onCursor(cb) {
      cursorCbs.add(cb);
      return () => cursorCbs.delete(cb);
    },
    onScroll(cb) {
      scrollCbs.add(cb);
      return () => scrollCbs.delete(cb);
    },
    highlightSearch(q) {
      highlight = toSearchQuery(q);
      if (!current) return;
      const fx: StateEffect<unknown>[] = [setHighlightQuery.of(highlight)];
      // Prime the in-file search panel too, so F3 / Enter jump between the same matches.
      if (highlight) fx.push(setSearchQuery.of(highlight));
      view.dispatch({ effects: fx });
    },
    applyChanges(path, changes, opts) {
      const target = path === current ? view.state : docs.get(path)?.state;
      if (!target) return;
      const len = target.doc.length;
      const valid = changes.filter((c) => c.from >= 0 && c.to <= len && c.from <= c.to);
      const sel = opts?.selection;
      applyTo(path, {
        changes: valid,
        selection: sel ? EditorSelection.single(sel.anchor, sel.head ?? sel.anchor) : undefined,
        userEvent: 'input.format',
        scrollIntoView: path === current && !!sel,
      });
    },
    getCursorOffset() {
      return view.state.selection.main.head;
    },
    getView() {
      return view;
    },
    setLanguage(path, languageId) {
      const rec = docs.get(path);
      if (!rec) return;
      let next = languageId ? (languageById(languageId)?.id ?? languageId.toLowerCase()) : null;
      if (next && next === autoLanguage(path).id) next = null; // picking the default = back to auto
      if ((langOverride.get(path) ?? null) === next) return;
      if (next) langOverride.set(path, next);
      else langOverride.delete(path);
      if (pending?.path === path) flushChange();
      // Swap the whole extension set in place: doc, selection and undo history (state fields) survive.
      // Compartments keep their old content across a full reconfigure, so each is set explicitly too.
      const state = path === current ? view.state : rec.state;
      collected = new Map();
      const exts = extensionsFor(path, state.doc.toString());
      const fx: StateEffect<unknown>[] = [StateEffect.reconfigure.of(exts), ...[...collected].map(([c, e]) => c.reconfigure(e))];
      collected = null;
      if (path === current) fx.push(view.scrollSnapshot());
      applyTo(path, { effects: fx });
      ensureLanguage(path);
      langCbs.forEach((cb) => cb(path));
    },
    getLanguage(path) {
      const p = path ?? current;
      if (!p) return null;
      const o = langOverride.get(p);
      if (o) {
        const info = languageById(o);
        return { id: info?.id ?? o, name: info?.name ?? o, auto: false };
      }
      return { ...autoLanguage(p), auto: true };
    },
    onLanguageChange(cb) {
      langCbs.add(cb);
      return () => langCbs.delete(cb);
    },
  };

  // Rebuild live decorations when the file list changes (wikilink resolution / images).
  const refresh = () => current && isMdView(current) && view.dispatch({ effects: refreshLive.of(null) });
  installEditorIntegration({ view: () => (current ? view : null), path: () => current, refresh, applySettings: (s) => ctrl.applySettings(s) });
  registerEditorCommands({
    view: () => (current ? view : null),
    isMarkdown: () => !!current && isMdView(current),
    isLive: () => !!current && isMdView(current) && mode === 'live',
  });
  return ctrl;
}
