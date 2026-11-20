// PDF tab (lazy chunk `PdfView`): toolbar (page x / y, zoom, find, dark pages) over pdf.js's PDFViewer.
// Mounted per path by the shell's Viewer (EditorExtras); unmount = document + worker destroyed.
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { basename } from '@shared/paths';
import { app } from '../app/app';
import { addGlobalKeyFilter, eventToKey } from '../app/commands';
import { addIcons, Icon } from '../app/icons';
import { registerUiProcessSource } from '../app/process-explorer/sources';
import { formatZoom } from './model';
import { PdfSession, sessions, viewStates } from './session';

addIcons({ minus: 'M5 12h14', chevronUp: 'M18 15l-6-6-6 6', chevronLeft: 'M15 18l-6-6 6-6' });

const DARK_KEY = 'sec-edit-pdf-dark';
const readDark = () => {
  try {
    return localStorage.getItem(DARK_KEY) === '1';
  } catch {
    return false;
  }
};

/** Keys the viewer handles itself while focus is inside it (they beat the global UI zoom). */
const OWN_KEYS = new Set(['Mod-f', 'Mod-=', 'Mod-+', 'Mod-Shift-=', 'Mod-Shift-+', 'Mod--', 'Mod-_', 'Mod-Shift-_', 'Mod-0', 'Mod-g']);
let unfilter: (() => void) | null = null;
let unsource: (() => void) | null = null;
function installOnce() {
  unfilter ??= addGlobalKeyFilter((e, key) => !(OWN_KEYS.has(key) && (e.target as HTMLElement | null)?.closest?.('.se-pdf')));
  unsource ??= registerUiProcessSource({
    id: 'pdf',
    rows: () => [...sessions].map((s) => ({ id: `pdf:${s.path}`, parent: 'renderer', kind: 'worker' as const, name: 'PDF.js worker', detail: s.path, state: s.loading.value ? 'loading' : `${s.numPages.value} pages` })),
  });
}

const ZOOM_CHOICES: Array<[string, string]> = [
  ['page-width', 'Fit width'],
  ['page-fit', 'Fit page'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
  ['4', '400%'],
];

export function PdfView({ path }: { path: string }) {
  const scrollEl = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<PdfSession | null>(null);
  const [dark, setDark] = useState(readDark);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pageText, setPageText] = useState<string | null>(null);

  useEffect(() => {
    installOnce();
    const el = scrollEl.current!;
    const s = new PdfSession(path, el, viewStates.get(path) ?? null);
    setSession(s);
    void s.load();
    el.focus({ preventScroll: true });
    // Ctrl+wheel (and trackpad pinch) zooms the page, not the app.
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      s.zoomStep(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => s.relayout());
    });
    ro.observe(el);
    const offs = [
      app.events.on('binary:changed', (p) => p === path && void s.reload()),
      app.events.on('viewer:reveal', (p, t) => {
        // Still loading: doc.reveal stays and 'pagesinit' takes it.
        if (p === path && t.page && s.goToPage(t.page)) delete app.docs.get(path)?.reveal;
      }),
    ];
    return () => {
      offs.forEach((o) => o());
      ro.disconnect();
      cancelAnimationFrame(raf);
      el.removeEventListener('wheel', onWheel);
      void s.destroy();
    };
  }, [path]);

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };
  const closeFind = () => {
    setFindOpen(false);
    session?.closeFind();
    scrollEl.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!session) return;
    const key = eventToKey(e);
    const handled = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (key === 'Mod-f') return handled(openFind);
    if (key === 'Mod-=' || key === 'Mod-+' || key === 'Mod-Shift-=' || key === 'Mod-Shift-+') return handled(() => session.zoomStep(1));
    if (key === 'Mod--' || key === 'Mod-_' || key === 'Mod-Shift-_') return handled(() => session.zoomStep(-1));
    if (key === 'Mod-0') return handled(() => session.setZoom('page-width'));
    if (key === 'Mod-g') return handled(() => pageInput.current?.select());
    if (key === 'Escape' && findOpen) return handled(closeFind);
  };

  const s = session;
  const n = s?.numPages.value ?? 0;
  const page = s?.page.value ?? 1;
  const preset = s?.preset.value ?? 'page-width';
  const zoomValue = preset || String(s?.scale.value ?? 1);
  const custom = !ZOOM_CHOICES.some(([v]) => v === zoomValue);
  const f = s?.find.value;

  return (
    <div class={`se-pdf${dark ? ' se-pdf-dark' : ''}`} onKeyDown={onKeyDown} data-path={path}>
      <div class="se-pdf-bar" role="toolbar" aria-label="PDF">
        <span class="se-pdf-name" title={path}>
          {basename(path)}
        </span>
        <span class="se-pdf-group">
          <button class="se-pdf-btn" title="Previous page" aria-label="Previous page" disabled={!s || page <= 1} onClick={() => s?.goToPage(page - 1)}>
            <Icon name="chevronUp" size={15} />
          </button>
          <input
            ref={pageInput}
            class="se-pdf-page"
            aria-label="Page"
            inputMode="numeric"
            value={pageText ?? String(page)}
            onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
            onInput={(e) => setPageText((e.currentTarget as HTMLInputElement).value)}
            onBlur={() => setPageText(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                app.markNavigation?.(); // a typed page is a jump: Go back returns
                s?.goToPage(Number((e.currentTarget as HTMLInputElement).value));
                setPageText(null);
                scrollEl.current?.focus({ preventScroll: true });
              } else if (e.key === 'Escape') {
                setPageText(null);
                scrollEl.current?.focus({ preventScroll: true });
              }
            }}
          />
          <span class="se-pdf-count">/ {n || '…'}</span>
          <button class="se-pdf-btn" title="Next page" aria-label="Next page" disabled={!s || page >= n} onClick={() => s?.goToPage(page + 1)}>
            <Icon name="chevronDown" size={15} />
          </button>
        </span>
        <span class="se-pdf-group">
          <button class="se-pdf-btn" title="Zoom out (Ctrl+-)" aria-label="Zoom out" onClick={() => s?.zoomStep(-1)}>
            <Icon name="minus" size={15} />
          </button>
          <select
            class="se-pdf-zoom"
            aria-label="Zoom"
            value={zoomValue}
            onChange={(e) => s?.setZoom((e.currentTarget as HTMLSelectElement).value)}
          >
            {custom && <option value={zoomValue}>{formatZoom(s?.scale.value ?? 1)}</option>}
            {ZOOM_CHOICES.map(([v, label]) => (
              <option value={v}>{label}</option>
            ))}
          </select>
          <button class="se-pdf-btn" title="Zoom in (Ctrl+=)" aria-label="Zoom in" onClick={() => s?.zoomStep(1)}>
            <Icon name="plus" size={15} />
          </button>
        </span>
        <span class="se-pdf-spacer" />
        <button class={`se-pdf-btn${findOpen ? ' on' : ''}`} title="Find in PDF (Ctrl+F)" aria-label="Find in PDF" onClick={() => (findOpen ? closeFind() : openFind())}>
          <Icon name="search" size={15} />
        </button>
        <button
          class={`se-pdf-btn se-pdf-darkbtn${dark ? ' on' : ''}`}
          title={dark ? 'Dark pages: on' : 'Dark pages: off'}
          aria-label="Dark pages"
          aria-pressed={dark}
          onClick={() => {
            const next = !dark;
            setDark(next);
            try {
              localStorage.setItem(DARK_KEY, next ? '1' : '0');
            } catch {}
          }}
        >
          <Icon name={dark ? 'moon' : 'sun'} size={15} />
        </button>
      </div>
      {findOpen && (
        <div class="se-pdf-find" role="search">
          <Icon name="search" size={14} />
          <input
            ref={findInput}
            class="se-pdf-find-input"
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            value={query}
            onInput={(e) => {
              const q = (e.currentTarget as HTMLInputElement).value;
              setQuery(q);
              s?.search(q);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                s?.search(query, { again: true, previous: e.shiftKey });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
          <span class={`se-pdf-find-count${f?.state === 'notfound' ? ' none' : ''}`}>
            {!query ? '' : f?.state === 'pending' && !f.total ? '…' : f?.total ? `${f.current} / ${f.total}` : 'No results'}
          </span>
          <button class="se-pdf-btn" title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={() => s?.search(query, { again: true, previous: true })}>
            <Icon name="chevronUp" size={15} />
          </button>
          <button class="se-pdf-btn" title="Next match (Enter)" aria-label="Next match" onClick={() => s?.search(query, { again: true })}>
            <Icon name="chevronDown" size={15} />
          </button>
          <button class="se-pdf-btn" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      <div class="se-pdf-body">
        {/* pdf.js requires an absolutely positioned scroll container with the page host as first child. */}
        <div class="se-pdf-scroll" ref={scrollEl} tabIndex={0} aria-label={`PDF ${basename(path)}`}>
          <div class="pdfViewer" />
        </div>
        {s?.error.value && (
          <div class="se-pdf-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{s.error.value}</span>
            <button class="se-btn small" onClick={() => void s.load()}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
