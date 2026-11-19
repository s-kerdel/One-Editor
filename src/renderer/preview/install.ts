// Preview commands. Deliberately tiny and free of heavy imports: this file is part of the startup
// bundle, while the preview itself (markdown-it, DOMPurify, …) is loaded on demand by the shell.
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { isMarkdown } from '@shared/paths';
import type { PreviewHandle } from './index';

export function installPreview(): void {
  const md = () => {
    const p = app.activePath.value;
    return !!p && isMarkdown(p);
  };
  const source = () => {
    const path = app.activePath.value!;
    return { path, src: app.editor?.getContent(path) ?? app.docs.get(path)?.content ?? '' };
  };
  const guard = (what: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      app.toast(`${what} failed: ${(err as Error)?.message ?? err}`, 'error');
    }
  };
  registerCommands([
    {
      id: 'preview.exportHtml',
      title: 'Export note to HTML',
      category: 'Preview',
      keywords: ['export', 'html', 'share', 'standalone'],
      when: md,
      run: guard('Export', async () => {
        const { exportHtml } = await import('./export');
        const { path, src } = source();
        await exportHtml(path, src);
      }),
    },
    {
      id: 'preview.exportPdf',
      title: 'Export note to PDF…',
      category: 'Preview',
      keywords: ['pdf', 'export', 'print', 'save as pdf'],
      when: md,
      run: guard('PDF export', async () => {
        const { path, src } = source();
        await (await import('./pdf')).exportPdf(path, src);
      }),
    },
    {
      // Not user-facing any more: "Export note to PDF…" replaced it. Kept (hidden) because browser
      // mode has no PDF engine, so its PDF export falls back to this print-dialog flow.
      id: 'preview.print',
      title: 'Print (PDF export fallback)',
      category: 'Preview',
      hidden: true,
      when: md,
      run: guard('Print', async () => {
        // In live/source mode the preview may not exist yet; the shell creates it on demand.
        if (!app.preview) await (await import('../app/EditorArea')).ensurePreview?.();
        const pv = app.preview as PreviewHandle | null;
        if (!pv?.settle) return void app.toast('Switch to split or reading view to print', 'info');
        await pv.settle(); // everything rendered + highlighted; the print stylesheet does the rest
        window.print();
      }),
    },
    {
      id: 'preview.copyHtml',
      title: 'Copy as HTML',
      category: 'Preview',
      keywords: ['copy', 'html', 'clipboard', 'rich text'],
      when: md,
      run: guard('Copy', async () => {
        const { copyHtml } = await import('./export');
        const { path, src } = source();
        await copyHtml(path, src);
      }),
    },
  ]);
}
