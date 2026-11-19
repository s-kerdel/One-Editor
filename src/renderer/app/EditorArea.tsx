// Editor + preview hosts. Both are loaded with import() so the shell paints before CodeMirror /
// markdown-it are even parsed; the editor chunk starts downloading at boot (see main.tsx).
import { useEffect, useRef } from 'preact/hooks';
import { isMarkdown } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import { markEditorReady, noteEdited } from './documents';
import { lazyComponent } from './lazy';

// Only shown with no open tab: not needed to paint a restored session.
const Welcome = lazyComponent(() => import('./Welcome').then((m) => m.Welcome));

type EditorModule = typeof import('../editor');
type PreviewModule = typeof import('../preview');

let editorModule: Promise<EditorModule> | null = null;
let previewModule: Promise<PreviewModule> | null = null;
/** Kicked off at boot, in parallel with the backend round-trip. */
export const loadEditorModule = () => (editorModule ??= import('../editor'));
export const loadPreviewModule = () => (previewModule ??= import('../preview'));

let previewHost: HTMLElement | null = null;
let previewCreating: Promise<void> | null = null;

/** Creates the preview the first time it is needed (split / reading view of a markdown doc). */
export function ensurePreview(): Promise<void> {
  if (app.preview || !previewHost) return Promise.resolve();
  previewCreating ??= loadPreviewModule().then((m) => {
    if (app.preview || !previewHost) return;
    app.preview = m.createPreview(previewHost);
    // The preview subscribes to app.events itself; it missed the current doc, so render it once.
    const p = app.activePath.value;
    if (p && isMarkdown(p)) app.preview.render(p, app.editor?.getContent(p) ?? app.docs.get(p)?.content ?? '');
  });
  return previewCreating;
}

let cursorRaf = 0;
function trackCursor() {
  cancelAnimationFrame(cursorRaf);
  cursorRaf = requestAnimationFrame(() => {
    ui.cursorInfo.value = app.activePath.value && app.editor ? app.editor.getCursor() : null;
  });
}

// Only needed in particular states (split mode, a conflict, a binary file): kept out of the startup chunk.
const loadExtras = () => import('./EditorExtras');
const SplitSash = lazyComponent<{ area: { current: HTMLDivElement | null } }>(() => loadExtras().then((m) => m.SplitSash));
const Banner = lazyComponent(() => loadExtras().then((m) => m.Banner));
const Viewer = lazyComponent<{ path: string }>(() => loadExtras().then((m) => m.Viewer));

export function EditorArea() {
  const area = useRef<HTMLDivElement>(null);
  const editorEl = useRef<HTMLDivElement>(null);
  const previewEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    previewHost = previewEl.current;
    let cancelled = false;
    const offs: Array<() => void> = [];
    void loadEditorModule().then((m) => {
      if (cancelled) return;
      const ed = m.createEditor(editorEl.current!);
      app.editor = ed;
      ed.applySettings(app.settings.value);
      ed.setViewMode(app.settings.value.viewMode);
      offs.push(ed.onChange((path, content) => noteEdited(path, content)), ed.onCursor(trackCursor));
      const offLang = ed.onLanguageChange?.(() => void ui.languageVersion.value++);
      if (offLang) offs.push(offLang);
      markEditorReady();
    });
    return () => {
      cancelled = true;
      offs.forEach((o) => o());
      app.preview?.dispose();
    };
  }, []);

  const mode = app.settings.value.viewMode;
  const active = app.activePath.value;
  const doc = active ? app.docs.get(active) : undefined;
  const md = ui.isMarkdownView(active);
  const effective = md ? mode : 'source';
  const viewer = !!doc?.binary;

  useEffect(() => {
    if (md && (mode === 'split' || mode === 'preview')) void ensurePreview();
  }, [md, mode]);
  useEffect(trackCursor, [active]);

  return (
    <div
      ref={area}
      class={`se-editor-area mode-${effective}${active ? '' : ' empty'}${viewer ? ' viewer' : ''}`}
      style={{ '--split': String(ui.splitRatio.value) }}
    >
      {active && (ui.conflicts.value.has(active) || ui.deletedOnDisk.value.has(active)) && <Banner />}
      <div class="se-editor-panes">
        <div class="se-editor-host" ref={editorEl} />
        {effective === 'split' && !viewer && <SplitSash area={area} />}
        <div class="se-preview-host" ref={previewEl} />
        {viewer && active && <Viewer path={active} />}
      </div>
      {/* While a session is being restored there will be a tab in a moment: don't flash the welcome screen. */}
      {!active && (app.ready.value || !app.workspace.value) && <Welcome />}
    </div>
  );
}
