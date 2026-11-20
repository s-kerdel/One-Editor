// State-specific parts of the editor area, loaded on demand: split drag handle, conflict /
// deleted-on-disk banner, and the viewer for images and binary files.
import { basename } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import { keepMine, persistSession, closeTabs, discardDoc } from './documents';
import { reloadFromDisk } from './disk-sync';
import { addIcons, Icon, isImagePath } from './icons';
import './icon-pack'; // alert (conflict banner)
import './editor-extras.css';
import { fileUrl } from '../platform';
import { revealInOs, revealLabel } from './fileops';
import { lazyComponent } from './lazy';

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
        <button class="se-btn small primary" onClick={() => void keepMine(p)}>
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
        <button class="se-btn small" onClick={() => revealInOs(path)}>
          {revealLabel()}
        </button>
      </div>
    </div>
  );
}

