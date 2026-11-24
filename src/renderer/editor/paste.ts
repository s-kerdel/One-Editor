// Paste / drop into Markdown notes:
//  - images (clipboard or dropped files) are saved as attachments and embedded as ![[name]];
//  - workspace files dragged from the file tree become [[links]] / ![[embeds]];
//  - rich HTML becomes Markdown; Mod-Shift-v pastes plain text; a pasted URL stays a plain URL.
import { EditorSelection, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { MAX_BINARY_BYTES } from '@shared/api';
import { isMarkdown } from '@shared/paths';
import { app } from '../app/app';
import { insertNode } from '../app/tree-model';
import { docPath } from './host';
import { inCodeContext } from './mdkeys';
import { htmlLooksRich, htmlToMarkdown } from './html-md';
import { pastedText } from '../whitespace/cm';
import { IMAGE_EXT_RE, attachmentDir, bytesToBase64, extForMime, linkMarkdown, pastedImageName, sanitizeFileName, uniquePath } from './attachments';

const TREE_MIME = 'application/x-sec-edit-paths';

/** Paths being written right now, so two quick pastes in the same second don't pick the same name. */
const reserved = new Set<string>();

function setting<T>(key: string): T | undefined {
  return app.settings.value[key] as T | undefined;
}

/** Writes raw bytes into the workspace (backend.writeBinary: creates parent folders, overwrites). */
export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  // Checked here too, so a huge drop fails fast with a clear message instead of after encoding + upload.
  if (bytes.length > MAX_BINARY_BYTES) throw new Error(`file is too large (${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_BINARY_BYTES / 1048576} MB)`);
  await app.backend.writeBinary(path, bytesToBase64(bytes));
}

function existsCheck(): (p: string) => boolean {
  // Case-insensitive: Windows / macOS file systems would collide on "Image.png" vs "image.png".
  const taken = new Set(app.files.value.map((f) => f.toLowerCase()));
  for (const r of reserved) taken.add(r.toLowerCase());
  return (p) => taken.has(p.toLowerCase());
}

function addToTree(path: string, size: number) {
  const tree = app.tree.value;
  if (!tree) return;
  const name = path.slice(path.lastIndexOf('/') + 1);
  app.tree.value = insertNode(tree, { name, path, kind: 'file', mtime: Date.now(), size });
  app.events.emit('tree:changed', app.tree.value);
}

/** Picks the attachment path for `fileName`, saves `blob` there (async) and returns the path at once. */
export function saveAttachment(blob: Blob, fileName: string, notePath: string): { path: string; done: Promise<boolean> } {
  const dir = attachmentDir(notePath, setting<string>('attachments.location'), setting<string>('attachments.folder'));
  const path = uniquePath(dir, sanitizeFileName(fileName), existsCheck());
  reserved.add(path);
  const done = (async () => {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeBytes(path, bytes);
      addToTree(path, bytes.length);
      return true;
    } catch (err) {
      app.toast(`Could not save ${fileName}: ${(err as Error)?.message ?? err}`, 'error', 6000);
      return false;
    } finally {
      reserved.delete(path);
    }
  })();
  return { path, done };
}

function nameFor(file: File, pasted: boolean): string {
  const ext = extForMime(file.type) ?? (/\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1].toLowerCase() || 'bin');
  // Clipboard images arrive as "image.png" (or nameless): use Obsidian's timestamped name.
  if (pasted || !file.name || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return pastedImageName(new Date(), ext);
  return file.name;
}

function filesFrom(dt: DataTransfer, imagesOnly: boolean): File[] {
  const out: File[] = [];
  const seen = new Set<File>();
  for (const f of Array.from(dt.files ?? [])) if (!seen.has(f)) seen.add(f), out.push(f);
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f && !out.some((o) => o.name === f.name && o.size === f.size && o.type === f.type)) out.push(f);
  }
  return imagesOnly ? out.filter((f) => f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name)) : out;
}

function insertAt(view: EditorView, from: number, to: number, text: string, userEvent: string) {
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), userEvent, scrollIntoView: true });
}

/** Saves files as attachments (or links existing workspace files) and inserts their embeds at from..to. */
export async function insertFiles(view: EditorView, files: File[], range: { from: number; to: number } | null, mode: 'paste' | 'drop' | 'pick'): Promise<void> {
  const notePath = view.state.facet(docPath);
  if (!app.workspace.value) return void app.toast('Open a folder first to add attachments', 'info');
  const links: string[] = [];
  const jobs: Promise<boolean>[] = [];
  for (const file of files) {
    // Electron: a file that already lives in the workspace is linked, not copied.
    const abs = mode === 'drop' ? app.backend.getPathForFile?.(file) : null;
    const resolved = abs ? await app.backend.resolvePath(abs).catch(() => null) : null;
    if (resolved?.rel && resolved.kind === 'file') {
      links.push(linkMarkdown(resolved.rel, app.files.value, notePath));
      continue;
    }
    const { path, done } = saveAttachment(file, nameFor(file, mode === 'paste'), notePath);
    jobs.push(done);
    links.push(linkMarkdown(path, [...app.files.value, path], notePath, IMAGE_EXT_RE.test(path) ? true : undefined));
  }
  if (!links.length) return;
  const sel = view.state.selection.main;
  const from = range ? Math.min(range.from, view.state.doc.length) : sel.from;
  const to = range ? Math.min(range.to, view.state.doc.length) : sel.to;
  insertAt(view, from, to, links.join(links.some((l) => l.startsWith('!')) ? '\n' : ' '), mode === 'paste' ? 'input.paste' : 'input.drop');
  view.focus();
  await Promise.all(jobs);
}

// ---- plain-text paste (Mod-Shift-v) ----
let plainUntil = 0;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let swallowUntil = 0;

function consumePlain(): boolean {
  const on = Date.now() < plainUntil;
  plainUntil = 0;
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = null;
  return on;
}

/** Inserts the clipboard's plain text (palette command / when the platform has no native paste-and-match-style). */
export async function pastePlainText(view: EditorView): Promise<boolean> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return false;
    view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
    view.focus();
    return true;
  } catch {
    app.toast('Clipboard is not accessible — use Ctrl+Shift+V', 'info');
    return false;
  }
}

const plainKey = Prec.high(
  keymap.of([
    {
      key: 'Mod-Shift-v',
      run: (view) => {
        // Let the browser's native "paste and match style" fire a paste event; we just mark it plain.
        // Electron without an Edit menu has no such binding: fall back to reading the clipboard.
        plainUntil = Date.now() + 600;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null;
          if (Date.now() >= plainUntil) return;
          plainUntil = 0;
          swallowUntil = Date.now() + 800; // a late native paste must not insert a second copy
          void pastePlainText(view);
        }, 150);
        return false;
      },
    },
  ]),
);

/**
 * The Markdown a rich clipboard becomes here, or null when the plain text is what should land
 * (no / flat HTML, inside a code block, or nothing gained over text/plain).
 * Cached per paste event: the smart-paste handler (../variables) asks first and this file's paste
 * handler reuses the answer, so htmlToMarkdown runs once per paste.
 */
let richFor: { e: ClipboardEvent; md: string | null } | null = null;

export function richPasteText(view: EditorView, e: ClipboardEvent): string | null {
  if (richFor && richFor.e === e) return richFor.md;
  const dt = e.clipboardData;
  const html = dt?.getData('text/html');
  let md: string | null = null;
  if (dt && html && isMarkdown(view.state.facet(docPath)) && !inCodeContext(view.state, view.state.selection.main.head) && htmlLooksRich(html)) {
    try {
      const conv = htmlToMarkdown(html);
      const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
      // Nothing gained over the exact plain text: keep that (CodeMirror's own paste).
      md = !conv || squash(conv) === squash(dt.getData('text/plain')) ? null : conv;
    } catch (err) {
      console.warn('[editor] html paste conversion failed', err);
    }
  }
  richFor = { e, md };
  return md;
}

const handlers = EditorView.domEventHandlers({
  paste(e, view) {
    const dt = e.clipboardData;
    if (!dt || !isMarkdown(view.state.facet(docPath))) return false;
    if (Date.now() < swallowUntil) {
      e.preventDefault();
      return true;
    }
    const plain = consumePlain();
    if (plain) return false; // CodeMirror inserts text/plain
    const images = filesFrom(dt, true);
    if (images.length) {
      e.preventDefault();
      void insertFiles(view, images, null, 'paste');
      return true;
    }
    const md = richPasteText(view, e);
    richFor = null; // last consumer: don't keep the clipboard payload alive
    if (!md) return false;
    e.preventDefault();
    // The same trailing-whitespace trim (and the Ctrl+Shift+V exemption) CodeMirror's own paste applies:
    // this dispatch goes past clipboardInputFilter, so it has to ask ../whitespace itself.
    view.dispatch(view.state.replaceSelection(pastedText(md, view.state.facet(docPath))), { userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
  dragover(e) {
    // Accept tree items / files (the drop cursor is drawn by CodeMirror).
    if (e.dataTransfer?.types.includes(TREE_MIME) || e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy'; // the tree allows copyMove; 'link' would make the browser reject the drop
    }
    return false;
  },
  drop(e, view) {
    const dt = e.dataTransfer;
    if (!dt || !isMarkdown(view.state.facet(docPath))) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    if (dt.types.includes(TREE_MIME)) {
      let paths: string[] = [];
      try {
        paths = JSON.parse(dt.getData(TREE_MIME)) as string[];
      } catch {}
      const from = view.state.facet(docPath);
      const files = app.files.value;
      const links = paths.filter((p) => files.includes(p) && p !== from).map((p) => linkMarkdown(p, files, from));
      if (!links.length) return false;
      e.preventDefault();
      insertAt(view, pos, pos, links.join(links.some((l) => l.startsWith('!')) ? '\n' : ' '), 'input.drop');
      view.focus();
      return true;
    }
    const files = filesFrom(dt, false);
    if (!files.length) return false;
    e.preventDefault();
    void insertFiles(view, files, { from: pos, to: pos }, 'drop');
    return true;
  },
});

export function pasteAndDrop(): Extension {
  return [plainKey, handlers];
}
