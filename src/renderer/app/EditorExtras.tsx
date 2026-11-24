// State-specific parts of the editor area, loaded on demand: split drag handle, conflict /
// deleted-on-disk banner, and the viewer for images and binary files.
import { basename } from '@shared/paths';
import { MAX_AS_TEXT_BYTES, MAX_AS_TEXT_FULL_BYTES, type FileData } from '@shared/api';
import { toMB } from '@shared/processes';
import { app, type Toast } from './app';
import * as ui from './ui';
import { save, persistSession, closeTabs, discardDoc, openFile } from './documents';
import { reloadFromDisk } from './disk-sync';
import { addIcons, Icon, isImagePath } from './icons';
import './icon-pack'; // alert (conflict banner)
import './editor-extras.css';
import { fileUrl } from '../platform';
import { revealInOs, revealLabel } from './fileops';
import { holdKeys, lazyComponent } from './lazy';

// pdf.js + its viewer: their own chunk, fetched when the first PDF opens.
const PdfView = lazyComponent<{ path: string }>(() => import('../pdf/PdfView').then((m) => m.PdfView));

// Icons only this lazily loaded chunk draws (see addIcons).
addIcons({ trash: 'M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M10 11v6|M14 11v6' });

export function SplitSash({ area }: { area: { current: HTMLDivElement | null } }) {
  return (
    <div
      class="se-split-sash"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onDblClick={() => {
        ui.splitRatio.value = 0.5;
        persistSession();
      }}
      onPointerDown={(e) => {
        const el = area.current;
        if (!el) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const rect = el.getBoundingClientRect();
        document.body.classList.add('se-resizing-x');
        const move = (ev: PointerEvent) => (ui.splitRatio.value = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width)));
        const up = () => {
          document.body.classList.remove('se-resizing-x');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          persistSession();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

export function Banner() {
  const p = app.activePath.value;
  if (!p) return null;
  if (ui.conflicts.value.has(p)) {
    return (
      <div class="se-banner warn" role="alert">
        <Icon name="alert" size={16} />
        <span class="se-banner-text">
          <b>{basename(p)}</b> changed on disk while you had unsaved edits.
        </span>
        <button class="se-btn small" onClick={() => reloadFromDisk(p)}>
          Use disk version
        </button>
        <button class="se-btn small primary" onClick={() => void save(p, { force: true })}>
          Keep mine
        </button>
      </div>
    );
  }
  if (ui.deletedOnDisk.value.has(p)) {
    return (
      <div class="se-banner warn" role="alert">
        <Icon name="trash" size={16} />
        <span class="se-banner-text">
          <b>{basename(p)}</b> was deleted on disk.
        </span>
        <button class="se-btn small" onClick={() => void app.saveFile(p)}>
          Restore (save)
        </button>
        <button
          class="se-btn small primary"
          onClick={() => {
            discardDoc(p);
            void closeTabs([p], { skipConfirm: true });
          }}
        >
          Close tab
        </button>
      </div>
    );
  }
  return null;
}

/**
 * Put force-opened text into the doc. `doc.binary` is left alone (still true): the save guard
 * (`doc-save.ts`), the search index and the git compare paths all key off it, so this file stays
 * non-savable whether the user got a window of it or the whole thing.
 */
function applyAsText(path: string, f: FileData): void {
  const doc = app.docs.get(path);
  if (!doc) return;
  doc.content = f.content;
  doc.saved = f.content; // moves with the content: the doc never looks "edited but unsavable"
  doc.mtime = f.mtime;
  doc.eol = f.eol;
  doc.asText = true;
  ui.docAsTextVersion.value++;
}

/**
 * "Open as text anyway": the backend's bounded window (MAX_AS_TEXT_BYTES). The limit is said twice —
 * on the card before the click, in the toast after it — and the rest is offered as a second step.
 */
async function openAsText(path: string) {
  const doc = app.docs.get(path);
  if (!doc) return;
  try {
    const f = await app.backend.readFile(path, { asText: true });
    applyAsText(path, f);
    await openFile(path); // the normal open path: it now sees doc.asText and puts the text in the editor
    const size = f.size ?? f.content.length;
    const actions: Toast['actions'] = [{ label: 'Set language', run: () => holdKeys(import('./Popups').then((m) => m.openLanguagePicker())) }];
    if (size > MAX_AS_TEXT_BYTES) {
      if (size <= MAX_AS_TEXT_FULL_BYTES) actions.push({ label: `Load all (${toMB(size)} MB)`, run: () => void loadAllText(path, size) });
      app.toast(`“${basename(path)}” opened as text: the first ${toMB(MAX_AS_TEXT_BYTES)} MB of ${toMB(size)}. Never saved back.`, 'info', 8000, actions);
    } else {
      app.toast(`“${basename(path)}” opened as text — never saved back.`, 'info', 6000, actions);
    }
  } catch (err) {
    app.toast(`Cannot open ${path} as text: ${(err as Error).message}`, 'error');
  }
}

/** "Load all": the whole file as text, behind a confirm that names the size. Still never savable. */
async function loadAllText(path: string, size: number) {
  if (!app.docs.get(path)?.asText) return;
  const mb = toMB(size);
  if (!(await ui.confirmDialog(`Load all ${mb} MB of ${basename(path)}?`, 'One may become slow while a file this large is open. It is still never saved back.', `Load ${mb} MB`))) return;
  try {
    const f = await app.backend.readFile(path, { asText: 'full' });
    applyAsText(path, f);
    app.editor?.setContent(path, f.content, { resetHistory: true }); // in place: no tab switch, no undo history of the window
    app.toast(`“${basename(path)}” loaded in full: ${toMB(f.size ?? f.content.length)} MB of text. Never saved back.`, 'info');
  } catch (err) {
    app.toast(`Cannot load all of ${path}: ${(err as Error).message}`, 'error');
  }
}

export function Viewer({ path }: { path: string }) {
  if (/\.pdf$/i.test(path)) return <PdfView key={path} path={path} />;
  if (isImagePath(path)) {
    return (
      <div class="se-viewer">
        <img class="se-viewer-img" src={fileUrl(app.backend, app.workspace.value?.root ?? '', path)} alt={basename(path)} />
        <div class="se-viewer-caption">{path}</div>
      </div>
    );
  }
  return (
    <div class="se-viewer">
      <div class="se-viewer-binary">
        <Icon name="file" size={40} />
        <p>
          <b>{basename(path)}</b> is a binary file and can’t be edited here.
        </p>
        <div class="se-viewer-actions">
          <button class="se-btn small primary" title={`Reads the first ${toMB(MAX_AS_TEXT_BYTES)} MB of the file as text; it is never saved back`} onClick={() => void openAsText(path)}>
            Open as text anyway
          </button>
          <button class="se-btn small" onClick={() => revealInOs(path)}>
            {revealLabel()}
          </button>
        </div>
        {/* The window has to be visible before the click, not only after it. */}
        <div class="se-viewer-caption">Opens the first {toMB(MAX_AS_TEXT_BYTES)} MB as text · never saved back</div>
      </div>
    </div>
  );
}

