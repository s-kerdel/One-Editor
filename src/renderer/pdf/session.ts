// One open PDF: pdf.js document + its PDFViewer (virtualised pages, text layer, links, find).
// Owned by the PdfView component; destroy() releases the document, its worker and every listener.
import { signal } from '@preact/signals';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { app } from '../app/app';
import { loadPdfjs, openPdfDocument, readPdfBytes } from './engine';
import { classifyLink, clampPage, stepZoom } from './model';

export interface ViewState {
  page: number;
  /** pdf.js scale value: 'page-width' | 'page-fit' | 'auto' or a number as string. */
  scale: string;
}

/** Last page / zoom per file, so switching tabs (which unmounts the viewer) comes back to the same spot. */
export const viewStates = new Map<string, ViewState>();

/** Live sessions (process explorer rows, E2E introspection). */
export const sessions = new Set<PdfSession>();

export class PdfSession {
  readonly numPages = signal(0);
  readonly page = signal(1);
  readonly scale = signal(1);
  /** Preset name while a fit mode is active ('page-width' / 'page-fit'), else ''. */
  readonly preset = signal('page-width');
  readonly error = signal<string | null>(null);
  readonly loading = signal(true);
  readonly find = signal<{ current: number; total: number; state: 'idle' | 'found' | 'notfound' | 'pending' | 'wrapped' }>({ current: 0, total: 0, state: 'idle' });

  private viewer: PDFViewer | null = null;
  private bus: EventBus | null = null;
  private links: PDFLinkService | null = null;
  private finder: PDFFindController | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private doc: PDFDocumentProxy | null = null;
  private ac = new AbortController();
  private generation = 0;
  private pending: ViewState | null;
  disposed = false;

  constructor(
    readonly path: string,
    private container: HTMLDivElement,
    initial: ViewState | null,
  ) {
    this.pending = initial;
    sessions.add(this);
    // Links on a page: internal ones are pdf.js's business; external ones only ever open on this click,
    // through the backend's allow-list (http/https/mailto) — never by navigating the app window.
    container.addEventListener(
      'click',
      (e) => {
        const a = (e.target as HTMLElement | null)?.closest?.('a');
        if (!a || !container.contains(a)) return;
        const kind = classifyLink(a.getAttribute('href'));
        if (kind === 'internal') return void app.markNavigation?.(); // Go back returns to the page with the link
        e.preventDefault();
        e.stopPropagation();
        if (kind === 'external') void app.backend.openExternal(a.href);
      },
      { capture: true, signal: this.ac.signal },
    );
    // Middle click / drag would open or navigate a window.
    container.addEventListener('auxclick', (e) => (e.target as HTMLElement)?.closest?.('a') && e.preventDefault(), { signal: this.ac.signal });
    container.addEventListener('dragstart', (e) => (e.target as HTMLElement)?.closest?.('a') && e.preventDefault(), { signal: this.ac.signal });
  }

  async load(): Promise<void> {
    const gen = ++this.generation;
    this.loading.value = true;
    this.error.value = null;
    let task: Awaited<ReturnType<typeof openPdfDocument>> | undefined;
    try {
      const { lib, viewer: V } = await loadPdfjs();
      if (this.disposed || gen !== this.generation) return;
      if (!this.viewer) this.createViewer(lib, V);
      const data = await readPdfBytes(this.path);
      if (this.disposed || gen !== this.generation) return;
      task = await openPdfDocument(data);
      const doc = await task.promise;
      if (this.disposed || gen !== this.generation) {
        void task.destroy();
        return;
      }
      const old = this.task;
      this.task = task;
      this.doc = doc;
      this.numPages.value = doc.numPages;
      this.viewer!.setDocument(doc);
      this.links!.setDocument(doc, null);
      void old?.destroy(); // a reload: the previous document (and its worker) go away now
    } catch (err) {
      // A rejected open (password, corrupt, half-written file) still owns a pdf.js worker: only destroy() ends it.
      if (task && task !== this.task) void task.destroy();
      if (this.disposed || gen !== this.generation) return;
      const e = err as Error & { name?: string };
      this.error.value = e?.name === 'PasswordException' ? 'This PDF is password protected.' : e?.name === 'InvalidPDFException' ? 'This file is not a valid PDF.' : (e?.message ?? String(err));
    } finally {
      if (gen === this.generation) this.loading.value = false;
    }
  }

  /** The file changed on disk: load it again where the reader was. */
  reload(): Promise<void> {
    if (this.viewer && this.doc) this.pending = this.state();
    return this.load();
  }

  private createViewer(lib: Awaited<ReturnType<typeof loadPdfjs>>['lib'], V: Awaited<ReturnType<typeof loadPdfjs>>['viewer']) {
    const bus = new V.EventBus();
    const links = new V.PDFLinkService({ eventBus: bus, externalLinkTarget: V.LinkTarget.NONE, externalLinkRel: 'noopener noreferrer nofollow' });
    const finder = new V.PDFFindController({ eventBus: bus, linkService: links });
    const viewer = new V.PDFViewer({
      container: this.container,
      viewer: this.container.firstElementChild as HTMLDivElement,
      eventBus: bus,
      linkService: links,
      findController: finder,
      textLayerMode: 1, // selectable text
      annotationMode: lib.AnnotationMode.ENABLE, // links, no form widgets (no submission)
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      removePageBorders: false, // keeps pdf.js's side padding in "fit width" (the border itself is transparent)
      enablePermissions: false,
      abortSignal: this.ac.signal,
    } as ConstructorParameters<typeof V.PDFViewer>[0]);
    links.setViewer(viewer);
    bus.on('pagesinit', () => {
      const want = this.pending;
      this.pending = null;
      viewer.currentScaleValue = want?.scale || 'page-width';
      const reveal = takeReveal(this.path);
      const page = reveal ?? want?.page;
      if (page && page > 1) viewer.currentPageNumber = clampPage(page, viewer.pagesCount) ?? 1;
    });
    bus.on('pagechanging', (e: { pageNumber: number }) => (this.page.value = e.pageNumber));
    bus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
      this.scale.value = e.scale;
      this.preset.value = e.presetValue && isNaN(Number(e.presetValue)) ? e.presetValue : '';
      this.remember();
    });
    bus.on('pagechanging', () => this.remember());
    // Navigation history follows the page (it records a jump only after markNavigation / a #page reveal).
    bus.on('pagechanging', (e: { pageNumber: number }) => app.events.emit('viewer:page', this.path, e.pageNumber));
    bus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) => {
      this.find.value = { ...this.find.value, current: e.matchesCount.current, total: e.matchesCount.total };
    });
    bus.on('updatefindcontrolstate', (e: { state: number; matchesCount?: { current: number; total: number } }) => {
      // FindState: FOUND 0, NOT_FOUND 1, WRAPPED 2, PENDING 3
      const state = (['found', 'notfound', 'wrapped', 'pending'] as const)[e.state] ?? 'idle';
      const m = e.matchesCount ?? this.find.value;
      this.find.value = { current: m.current, total: m.total, state };
    });
    this.viewer = viewer;
    this.bus = bus;
    this.links = links;
    this.finder = finder;
  }

  private state(): ViewState {
    const v = this.viewer!;
    return { page: v.currentPageNumber, scale: this.preset.value || String(v.currentScale) };
  }

  private remember() {
    if (this.viewer && this.doc && !this.pending) viewStates.set(this.path, this.state());
  }

  /** false while no document is shown yet (the caller keeps its request for 'pagesinit'). */
  goToPage(n: number): boolean {
    const v = this.viewer;
    if (!v || !this.doc || !v.pagesCount) return false;
    const p = clampPage(n, v.pagesCount);
    if (p) v.currentPageNumber = p;
    return true;
  }

  /** 'page-width' / 'page-fit' / 'auto' or a scale (1 = 100%). */
  setZoom(value: string | number) {
    if (!this.viewer || !this.doc) return;
    this.viewer.currentScaleValue = String(value);
  }

  zoomStep(dir: 1 | -1) {
    if (!this.viewer || !this.doc) return;
    this.viewer.currentScale = stepZoom(this.viewer.currentScale, dir);
  }

  /** The fit modes depend on the container size. */
  relayout() {
    if (this.viewer && this.doc && this.preset.value) this.viewer.currentScaleValue = this.preset.value;
  }

  search(query: string, opts: { again?: boolean; previous?: boolean } = {}) {
    if (!this.bus) return;
    if (!query) return this.closeFind();
    this.bus.dispatch('find', { source: this, type: opts.again ? 'again' : '', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: !!opts.previous, matchDiacritics: false });
  }

  closeFind() {
    this.bus?.dispatch('findbarclose', { source: this });
    this.find.value = { current: 0, total: 0, state: 'idle' };
  }

  /** E2E / diagnostics: pages with a finished canvas. */
  renderedPages(): number[] {
    const out: number[] = [];
    const v = this.viewer;
    if (!v) return out;
    for (let i = 0; i < v.pagesCount; i++) if (v.getPageView(i)?.renderingState === 3) out.push(i + 1);
    return out;
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    sessions.delete(this);
    this.ac.abort(); // our listeners + the viewer's resize / scroll watchers
    try {
      this.finder?.setDocument(null as unknown as PDFDocumentProxy);
      this.viewer?.setDocument(null as unknown as PDFDocumentProxy);
      this.links?.setDocument(null as unknown as PDFDocumentProxy, null);
    } catch {}
    this.viewer = null;
    this.bus = null;
    this.links = null;
    this.finder = null;
    this.doc = null;
    const task = this.task;
    this.task = null;
    await task?.destroy().catch(() => {}); // document + the worker it created
  }
}

/** A page asked for by `openFile(path, { page })` (`[[doc.pdf#page=3]]`), consumed once. */
export function takeReveal(path: string): number | null {
  const doc = app.docs.get(path);
  const page = doc?.reveal?.page ?? null;
  if (doc) delete doc.reveal;
  return page;
}
