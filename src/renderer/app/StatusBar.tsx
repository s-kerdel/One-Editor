// Status bar: save state · cursor · words (markdown, selection-aware) · EOL (click toggles) · encoding · language · mode.
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { app } from './app';
import * as ui from './ui';
import { Icon } from './icons';
import { setDocEol } from './documents';
import { setViewMode } from './settings';
import { runCommand } from './commands';
import { holdKeys } from './lazy';
import { absolutePath, copyText, expandTo, revealInOs, revealInTree, revealLabel } from './fileops';
import { openWorkspaceMenu } from './Shelf';
import { isMarkdown } from '@shared/paths';
import { countWords } from './wordcount';
import { gitUi } from '../git/install';

export { countWords };

/** Path of the open file as clickable crumbs: folder → reveal + expand it in the tree; file → reveal it. */
function Breadcrumb({ path }: { path: string }) {
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

// The language table is only needed to label the active file, so it stays out of the startup
// chunk: it arrives with the first open file (the editor chunk needs it anyway).
const languages = signal<typeof import('@shared/languages') | null>(null);
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

export function StatusBar() {
  const active = app.activePath.value;
  const doc = active ? app.docs.get(active) : undefined;
  ui.docMetaVersion.value; // re-render on eol/encoding changes
  ui.languageVersion.value;
  const md = ui.isMarkdownView(active);
  const words = useWordCount(active, md);
  const cur = ui.cursorInfo.value;
  const lang = active ? languageName(active) : null;
  const saving = active ? ui.saving.value.has(active) : false;
  const conflict = active ? ui.conflicts.value.has(active) : false;
  const gone = active ? ui.deletedOnDisk.value.has(active) : false;
  const dirty = !!doc?.dirty.value;
  const ws = app.workspace.value;
  const GitBranch = gitUi.value?.Branch; // lazy git chunk; after the save state so nothing shifts when it appears

  let state: { label: string; cls: string; icon?: string } | null = null;
  if (doc && !doc.binary) {
    if (conflict) state = { label: 'Conflict', cls: 'warn', icon: 'alert' };
    else if (gone) state = { label: 'Deleted on disk', cls: 'warn', icon: 'alert' };
    else if (saving) state = { label: 'Saving…', cls: 'muted' };
    else if (dirty) state = { label: app.settings.value.autosave ? 'Edited' : 'Unsaved', cls: 'dirty' };
    else state = { label: 'Saved', cls: 'ok', icon: 'check' };
  }

  return (
    <footer class="se-status">
      <button
        class="se-status-item se-status-sidebar"
        title={`${app.sidebarVisible.value ? 'Hide' : 'Show'} sidebar (Ctrl+Shift+B)`}
        aria-label="Toggle sidebar"
        onClick={() => void runCommand('view.toggleSidebar')}
      >
        <Icon name="sidebar" size={13} />
      </button>
      {ws && (
        <button
          class="se-status-item se-status-btn se-status-ws"
          title={`${ws.root}\nSwitch folder · reveal · copy path`}
          aria-label="Folder menu"
          data-testid="status-folder"
          onClick={(e) =>
            openWorkspaceMenu(e.currentTarget, 'above', [
              { label: revealLabel(), icon: 'reveal', run: () => revealInOs('') },
              { label: 'Copy folder path', icon: 'copy', run: () => copyText(absolutePath(''), 'Folder path') },
            ])
          }
        >
          <Icon name="folder" size={12} /> {ws.name}
        </button>
      )}
      {ws && active && <Breadcrumb path={active} />}
      {state && (
        <span class={`se-status-item se-save-state ${state.cls}`} data-state={state.cls}>
          {state.icon && <Icon name={state.icon} size={12} />}
          {state.label}
        </span>
      )}
      {GitBranch && <GitBranch />}
      <span class="se-status-spacer" />
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
        <button class="se-status-item se-status-btn" data-testid="eol" title="Line endings — click to switch" onClick={() => setDocEol(active!, doc.eol === 'crlf' ? 'lf' : 'crlf')}>
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
          title="Language mode — click to change"
          aria-haspopup="listbox"
          aria-expanded={ui.picker.value?.anchor ? 'true' : undefined}
          disabled={!doc || !!doc.binary}
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
    </footer>
  );
}
