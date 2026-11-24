// The open file's parts of the status bar (path crumbs, save state, cursor, words, EOL, encoding,
// language, view mode) and of the tab strip (content width + view-mode switch). Lazy chunk: the first
// frame has no open file. Layout.preloadDocChrome() resolves it alongside session restore (or on idle),
// so these parts still arrive in the same frame as the file.
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { Settings } from '@shared/api';
import { basename, extname, isMarkdown } from '@shared/paths';
import { extDisplay, isExtPath } from '@shared/external';
import { app } from './app';
import * as ui from './ui';
import { Icon } from './icons';
import './icon-pack'; // check / alert (save state), the mode and width glyphs
import { save } from './documents';
import { setViewMode, currentWidth, updateSettings, WIDTHS } from './settings';
import { prettyKey } from './commands';
import { holdKeys } from './lazy';
import { expandTo, revealInTree } from './fileops';
import { countWords } from './wordcount';

/** Changes a doc's line endings (status bar toggle); saved on the next save. */
function setDocEol(path: string, eol: 'lf' | 'crlf') {
  const doc = app.docs.get(path);
  if (!doc || doc.eol === eol) return;
  doc.eol = eol;
  doc.saved = `\u0000eol-changed\u0000${doc.saved}`; // forces dirty until saved
  doc.dirty.value = true;
  ui.docMetaVersion.value++;
  if (app.settings.value.autosave) void save(path, { auto: true });
}

/** Tab-strip button: readable → wide → full → readable. */
const cycleContentWidth = () => updateSettings({ contentWidth: WIDTHS[(WIDTHS.indexOf(currentWidth()) + 1) % 3] });

// ---- status bar ------------------------------------------------------------------------------

/** Path of the open file as clickable crumbs: folder → reveal + expand it in the tree; file → reveal it. */
function Breadcrumb({ path }: { path: string }) {
  if (isExtPath(path)) {
    // Outside the open folder: no tree to reveal it in; the folder is the tooltip.
    return (
      <span class="se-status-crumbs" aria-label="File path">
        <span class="se-crumb-sep">›</span>
        <span class="se-crumb file" title={extDisplay(path)}>{basename(path)}</span>
      </span>
    );
  }
  const segs = path.split('/');
  const name = segs.pop()!;
  const shown = segs.length > 3 ? segs.slice(-3) : segs; // keep the bar short on deep paths
  const hidden = segs.length - shown.length;
  return (
    <span class="se-status-crumbs" aria-label="File path">
      {hidden > 0 && <span class="se-crumb-sep" title={segs.slice(0, hidden).join('/')}>…</span>}
      {shown.map((seg, i) => {
        const dir = segs.slice(0, hidden + i + 1).join('/');
        return (
          <>
            <span class="se-crumb-sep">›</span>
            <button class="se-crumb" title={`Show “${dir}” in the file tree`} onClick={() => (revealInTree(dir), expandTo(dir, true))}>
              {seg}
            </button>
          </>
        );
      })}
      <span class="se-crumb-sep">›</span>
      <button class="se-crumb file" title="Show in the file tree" onClick={() => revealInTree(path)}>
        {isMarkdown(name) ? name.replace(/\.(md|markdown|mdx)$/i, '') : name}
      </button>
    </span>
  );
}

// The language table is only needed to label the active file: it arrives with the first open file
// (the editor chunk needs it anyway).
const languages = signal<typeof import('@shared/languages') | null>(null);
const fileTypeLabel = (path: string) => {
  const ext = extname(path).slice(1);
  return ext === 'pdf' ? 'PDF' : ext ? ext.toUpperCase() : 'Binary';
};

let languagesRequested = false;
function languageName(path: string): string | null {
  // The editor knows best (overrides, detection); before it has the doc, go by override / extension.
  const fromEditor = app.editor?.getLanguage?.(path)?.name;
  if (fromEditor) return fromEditor;
  const mod = languages.value;
  const override = ui.languageOverrides.value[path];
  if (mod) return ((override && mod.languageForFence(override)) || mod.languageForPath(path))?.name ?? 'Plain text';
  if (!languagesRequested) {
    languagesRequested = true;
    void import('@shared/languages').then((m) => (languages.value = m));
  }
  return null;
}

const MODE_LABEL = { live: 'Live', source: 'Source', split: 'Split', preview: 'Reading' } as const;
const NEXT_MODE = { live: 'source', source: 'split', split: 'preview', preview: 'live' } as const;
const ENC_LABEL: Record<string, string> = { utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', 'windows-1252': 'Windows 1252' };

// Whole-note counts cached per path, keyed on the stored content string (same reference while the
// note is unchanged → O(1) hit), so switching tabs to a 1 MB note doesn't rescan it every time.
const wcCache = new Map<string, { src: string; words: number; chars: number }>();
function noteCount(path: string, text: string) {
  const hit = wcCache.get(path);
  if (hit && hit.src === text) return hit;
  const r = { src: text, ...countWords(text) };
  wcCache.delete(path);
  wcCache.set(path, r);
  if (wcCache.size > 64) wcCache.delete(wcCache.keys().next().value!);
  return r;
}

function selectionText(): string | null {
  // Feature-detected escape hatch: CodeMirror view for the selected text.
  const view = app.editor?.getView?.() as { state: { selection: { main: { from: number; to: number } }; sliceDoc(a: number, b: number): string } } | undefined;
  const sel = view?.state.selection.main;
  if (!view || !sel || sel.from === sel.to) return null;
  return view.state.sliceDoc(sel.from, sel.to);
}

function useWordCount(path: string | null, md: boolean) {
  const [count, setCount] = useState<{ words: number; chars: number; selected: boolean } | null>(null);
  const cursor = ui.cursorInfo.value;
  useEffect(() => {
    if (!path || !md) return setCount(null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const compute = () => {
      const sel = selectionText();
      if (sel !== null) return setCount({ ...countWords(sel), selected: true });
      const text = app.docs.get(path)?.content ?? app.editor?.getContent(path) ?? '';
      const c = noteCount(path, text);
      setCount({ words: c.words, chars: c.chars, selected: false });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      const size = app.docs.get(path)?.content.length ?? 0;
      timer = setTimeout(compute, size > 200_000 ? 500 : 120);
    };
    // Big notes that aren't cached yet: count after the tab switch has painted.
    const size = app.docs.get(path)?.content.length ?? 0;
    const cached = wcCache.get(path)?.src === app.docs.get(path)?.content;
    if (size > 200_000 && !cached) {
      setCount(null);
      schedule();
    } else compute();
    const off = app.events.on('doc:changed', (p) => p === path && schedule());
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [path, md]);
  // Selection changes arrive via the cursor signal.
  useEffect(() => {
    if (!path || !md) return;
    const sel = selectionText();
    if (sel !== null || count?.selected) {
      const text = sel ?? app.editor?.getContent(path) ?? '';
      setCount({ ...countWords(text), selected: sel !== null });
    }
  }, [cursor?.selectionLength]);
  return count;
}

/** Left of the git / variables pills: crumbs (with a folder open) and the save state. */
export function StatusDocStart({ path, crumbs }: { path: string; crumbs: boolean }) {
  const doc = app.docs.get(path);
  const saving = ui.saving.value.has(path);
  const conflict = ui.conflicts.value.has(path);
  const gone = ui.deletedOnDisk.value.has(path);
  const dirty = !!doc?.dirty.value;
  let state: { label: string; cls: string; icon?: string } | null = null;
  if (doc && !doc.binary) {
    if (conflict) state = { label: 'Conflict', cls: 'warn', icon: 'alert' };
    else if (gone) state = { label: 'Deleted on disk', cls: 'warn', icon: 'alert' };
    else if (saving) state = { label: 'Saving…', cls: 'muted' };
    else if (dirty) state = { label: app.settings.value.autosave ? 'Edited' : 'Unsaved', cls: 'dirty' };
    else state = { label: 'Saved', cls: 'ok', icon: 'check' };
  }
  return (
    <>
      {crumbs && <Breadcrumb path={path} />}
      {state && (
        <span class={`se-status-item se-save-state ${state.cls}`} data-state={state.cls}>
          {state.icon && <Icon name={state.icon} size={12} />}
          {state.label}
        </span>
      )}
    </>
  );
}

/** Right end of the bar: cursor, words, EOL, encoding, language, view mode. */
export function StatusDocEnd({ path }: { path: string }) {
  const doc = app.docs.get(path);
  ui.docMetaVersion.value; // re-render on eol/encoding changes
  ui.docAsTextVersion.value; // re-render when a binary doc is force-opened as text
  ui.languageVersion.value;
  const md = ui.isMarkdownView(path);
  const words = useWordCount(path, md);
  const cur = ui.cursorInfo.value;
  // Viewer tabs (PDF…) have no language mode: name the file type instead of "Plain text". A binary file
  // opened as text does have one, so its language is shown and can be changed like any other file.
  const viewer = !!doc?.binary && !doc.asText;
  const lang = viewer ? fileTypeLabel(path) : languageName(path);
  return (
    <>
      {cur && doc && !doc.binary && (
        <span class="se-status-item" title="Line, column">
          Ln {cur.line + 1}, Col {cur.col + 1}
          {cur.selectionLength > 0 && <span class="se-status-sel"> ({cur.selectionLength} selected)</span>}
        </span>
      )}
      {words && (
        <span class="se-status-item" data-testid="word-count" title={words.selected ? 'Selection' : 'Document'}>
          {words.words.toLocaleString()} {words.words === 1 ? 'word' : 'words'} · {words.chars.toLocaleString()} chars
        </span>
      )}
      {doc && !doc.binary && (
        <button class="se-status-item se-status-btn" data-testid="eol" title="Line endings — click to switch" onClick={() => setDocEol(path, doc.eol === 'crlf' ? 'lf' : 'crlf')}>
          {doc.eol === 'crlf' ? 'CRLF' : 'LF'}
        </button>
      )}
      {doc && !doc.binary && (
        <span class="se-status-item" title="Encoding">
          {ENC_LABEL[doc.encoding ?? 'utf8']}
          {doc.bom ? ' BOM' : ''}
        </span>
      )}
      {lang && (
        <button
          class="se-status-item se-status-btn"
          data-testid="language"
          title={viewer ? 'File type' : 'Language mode — click to change'}
          aria-haspopup="listbox"
          aria-expanded={ui.picker.value?.anchor ? 'true' : undefined}
          disabled={!doc || viewer}
          onClick={(e) => {
            const anchor = e.currentTarget;
            // Typing right after the click (while the chunk loads) lands in the picker's filter.
            holdKeys(import('./Popups').then((m) => m.openLanguagePicker(anchor)));
          }}
        >
          {lang}
        </button>
      )}
      {md && (
        <button class="se-status-item se-status-btn" data-testid="view-mode" title="View mode — click to cycle" onClick={() => setViewMode(NEXT_MODE[app.settings.value.viewMode])}>
          {MODE_LABEL[app.settings.value.viewMode]}
        </button>
      )}
    </>
  );
}

// ---- tab strip -------------------------------------------------------------------------------

const MODES: Array<{ id: Settings['viewMode']; icon: string; title: string; keys?: string }> = [
  { id: 'live', icon: 'pencil', title: 'Live preview' },
  { id: 'source', icon: 'code', title: 'Source' },
  { id: 'split', icon: 'columns', title: 'Split', keys: 'Mod-\\' },
  { id: 'preview', icon: 'eye', title: 'Reading view', keys: 'Mod-e' },
];

function ViewModeSwitch() {
  const mode = app.settings.value.viewMode;
  return (
    <div class="se-modes" role="radiogroup" aria-label="View mode">
      {MODES.map((m) => (
        <button
          class={`se-mode${mode === m.id ? ' active' : ''}`}
          role="radio"
          aria-checked={mode === m.id}
          data-mode={m.id}
          title={m.keys ? `${m.title} (${prettyKey(m.keys)})` : m.title}
          onClick={() => setViewMode(m.id)}
        >
          <Icon name={m.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

const WIDTH_LABEL = { readable: 'Readable', wide: 'Wide', full: 'Full width' } as const;

/** Markdown text column: readable → wide → full (also Settings → Appearance and "View: Content width…"). */
function WidthToggle() {
  const w = currentWidth();
  return (
    <button class="se-width-btn" data-testid="content-width" data-width={w} aria-label={`Content width: ${WIDTH_LABEL[w]}`} title={`Content width: ${WIDTH_LABEL[w]} — click to change`} onClick={cycleContentWidth}>
      <Icon name={`w${w}`} size={16} />
    </button>
  );
}

/** Markdown view: content width + view mode, left of the file overview toggle. */
export function TabDocTools() {
  return (
    <>
      <WidthToggle />
      <span class="se-tools-sep" />
      <ViewModeSwitch />
      <span class="se-tools-sep" />
    </>
  );
}
