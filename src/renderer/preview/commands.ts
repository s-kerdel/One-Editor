// Preview commands (export HTML / PDF, print, copy as HTML). None has keys, so they load with the
// palette / once idle after boot (addCommandSource in ./install) — the preview itself (markdown-it,
// DOMPurify, …) is loaded on demand by the shell.
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { isMarkdown } from '@shared/paths';
import type { PreviewHandle } from './index';

let registered = false;
export function registerPreviewCommands(): void {
  if (registered) return;
  registered = true;
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
    // Remote images (./remote): the folder's choice, also reachable without the preview's bar.
    ...(
      [
        ['preview.remoteImages.allowFolder', 'Images from the internet: always load in this folder', 'allow'],
        ['preview.remoteImages.blockFolder', 'Images from the internet: never load in this folder', 'block'],
        ['preview.remoteImages.resetFolder', 'Images from the internet: use the default for this folder', null],
      ] as const
    ).map(([id, title, v]) => ({
      id,
      title,
      category: 'Preview',
      keywords: ['remote', 'external', 'tracking', 'privacy', 'load images', 'block images'],
      when: () => !!app.workspace.value,
      run: async () => {
        const { setFolderRemote } = await import('./remote');
        setFolderRemote(v);
        app.toast(v === 'allow' ? 'Images from the internet load in this folder' : v === 'block' ? 'Images from the internet are blocked in this folder' : 'This folder follows Settings → Preview again', 'info');
      },
    })),
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
