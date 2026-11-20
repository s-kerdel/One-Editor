// @vitest-environment happy-dom
// A failed open (password, corrupt, half-written file) must still destroy its loading task: in pdf.js
// only destroy() ends the worker that getDocument started.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tasks: Array<{ promise: Promise<unknown>; destroy: ReturnType<typeof vi.fn> }> = [];
let nextOpen: () => Promise<unknown> = () => Promise.reject(Object.assign(new Error('bad'), { name: 'InvalidPDFException' }));

vi.mock('../../../src/renderer/app/app', () => ({ app: { events: { emit() {} }, backend: {} } }));
vi.mock('../../../src/renderer/pdf/engine', () => {
  class Stub {
    on() {}
    setViewer() {}
    setDocument() {}
  }
  return {
    loadPdfjs: async () => ({
      lib: { AnnotationMode: { ENABLE: 1 }, AnnotationEditorType: { DISABLE: -1 } },
      viewer: { EventBus: Stub, PDFLinkService: Stub, PDFFindController: Stub, PDFViewer: Stub, LinkTarget: { NONE: 0 } },
    }),
    readPdfBytes: async () => new Uint8Array([1]),
    openPdfDocument: async () => {
      const promise = nextOpen();
      promise.catch(() => {});
      const t = { promise, destroy: vi.fn(async () => {}) };
      tasks.push(t);
      return t;
    },
  };
});

const { PdfSession } = await import('../../../src/renderer/pdf/session');

function session() {
  const box = document.createElement('div');
  box.appendChild(document.createElement('div'));
  return new PdfSession('doc.pdf', box, null);
}

describe('PdfSession failed loads', () => {
  beforeEach(() => void (tasks.length = 0));

  it('destroys the loading task when the document fails to open', async () => {
    const s = session();
    await s.load();
    expect(s.error.value).toBe('This file is not a valid PDF.');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys only the failed reload task, keeping the shown document', async () => {
    const s = session();
    nextOpen = () => Promise.resolve({ numPages: 2 });
    await s.load();
    nextOpen = () => Promise.reject(Object.assign(new Error('bad'), { name: 'InvalidPDFException' }));
    await s.load(); // e.g. latexmk truncated the file before rewriting it
    expect(tasks).toHaveLength(2);
    expect(tasks[0].destroy).not.toHaveBeenCalled();
    expect(tasks[1].destroy).toHaveBeenCalledTimes(1);
  });
});
