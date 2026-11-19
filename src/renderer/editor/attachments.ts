// Attachment naming + placement (pure). Obsidian conventions: "Pasted image 20261118-221530.png",
// collisions get " 1", " 2"…; location from settings `attachments.location` + `attachments.folder`.
import { basename, dirname, extname, isMarkdown, join, normalize, stem } from '@shared/paths';
import { resolveWikiTarget } from '@shared/wikilinks';

export type AttachmentLocation = 'root' | 'note' | 'subfolder';

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
export const EMBEDDABLE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|pdf|mp3|wav|ogg|m4a|flac|mp4|webm|ogv|mov)$/i;

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'application/pdf': 'pdf',
};

export function extForMime(mime: string): string | null {
  return MIME_EXT[mime.toLowerCase()] ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Pasted image 20261118-221530.png" (local time). */
export function pastedImageName(d: Date, ext = 'png'): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

/** File name safe on Windows and inside [[wikilinks]] (no \ / : * ? " < > | # ^ [ ]). */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  const base = cleaned || 'attachment';
  // Reserved device names on Windows.
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? `_${base}` : base;
}

/** Folder (workspace-relative, '' = root) where attachments for `notePath` go. */
export function attachmentDir(notePath: string, location: AttachmentLocation | string | undefined, folder: string | undefined): string {
  const f = normalize(typeof folder === 'string' ? folder : 'attachments');
  const noteDir = dirname(notePath);
  if (location === 'note') return noteDir;
  if (location === 'subfolder') return join(noteDir, f || 'attachments');
  return f; // 'root' (default): <workspace>/<folder>
}

/** First free path: "name.ext", "name 1.ext", "name 2.ext"… (`exists` should be case-insensitive on Windows). */
export function uniquePath(dir: string, fileName: string, exists: (p: string) => boolean): string {
  const ext = extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const realExt = ext ? fileName.slice(-ext.length) : '';
  let p = join(dir, fileName);
  for (let n = 1; exists(p) && n < 10_000; n++) p = join(dir, `${base} ${n}${realExt}`);
  return p;
}

/** Markdown for a workspace file dropped/pasted into `fromPath`: `![[img.png]]`, `[[Note]]`, `![[doc.pdf]]`. */
export function linkMarkdown(path: string, files: readonly string[], fromPath: string, embed?: boolean): string {
  const md = isMarkdown(path);
  const name = md ? stem(path) : basename(path);
  let target = resolveWikiTarget(name, files, fromPath) === path ? name : md ? path.replace(/\.(md|markdown|mdx)$/i, '') : path;
  if (/[|\]]/.test(target)) target = target.replace(/[|\]]/g, ' ');
  const bang = embed ?? (!md && EMBEDDABLE_RE.test(path));
  return `${bang ? '!' : ''}[[${target}]]`;
}

/** Bytes → string with one char per byte (U+0000–U+00FF). */
export function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return s;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToLatin1(bytes));
}
