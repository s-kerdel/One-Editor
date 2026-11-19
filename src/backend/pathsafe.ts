// Pure path-safety rules. Every helper takes the `path` flavour explicitly, so the Windows rules are
// unit-tested on Linux with `path.win32` (we have no Windows CI).
type PlatformPath = typeof import('node:path').posix;
import { normalize } from '../shared/paths';
import { BackendFailure } from './errors';

/** `path.relative(root, x)` result → does x lie outside root? ('..notes' is a legal name *inside*.) */
export function escapesRoot(relBack: string, p: PlatformPath): boolean {
  return relBack === '..' || relBack.startsWith('..' + p.sep) || p.isAbsolute(relBack);
}

/** True if `child` is `parent` or below it (case-insensitive where the FS usually is). */
export function isInsideDir(child: string, parent: string, p: PlatformPath, foldCase: boolean): boolean {
  const a = foldCase ? child.toLowerCase() : child;
  const b = foldCase ? parent.toLowerCase() : parent;
  return !escapesRoot(p.relative(b, a), p);
}

// Device names Win32 maps to devices, also with an extension or trailing spaces ("nul.md", "CON .txt").
// Writing "aux.md" on Windows 10 talks to a device instead of a file → the user's text silently vanishes.
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)\s*(\..*)?$/i;
// ':' would address an NTFS alternate data stream ("a.md:hidden") or another drive.
const WIN_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Why `name` cannot be a Windows file name, or null if it is fine. */
export function windowsNameProblem(name: string): string | null {
  if (WIN_BAD_CHARS.test(name)) return 'contains a character Windows does not allow (< > : " | ? * or a control character)';
  // Win32 silently strips these, so "a.md." would read/write "a.md" (a different file than the tree shows).
  if (/[. ]$/.test(name)) return 'ends with a dot or a space';
  if (WIN_RESERVED.test(name)) return 'is a reserved device name on Windows';
  return null;
}

/** Workspace-relative path → absolute native path, refusing anything outside `root`. */
export function resolveInside(root: string, rel: string, p: PlatformPath, win: boolean): string {
  const clean = normalize(rel);
  const segs = clean ? clean.split('/') : [];
  if (win) {
    for (const s of segs) {
      const why = windowsNameProblem(s);
      if (why) throw new BackendFailure('EINVAL', `Invalid file name "${s}": ${why}`);
    }
  }
  const full = p.resolve(root, ...segs);
  if (escapesRoot(p.relative(root, full), p)) throw new BackendFailure('OUTSIDE_WORKSPACE', `Path escapes workspace: ${rel}`);
  return full;
}

/** Absolute native path → workspace-relative POSIX path, or null if outside `root`. */
export function relativeInside(root: string, abs: string, p: PlatformPath): string | null {
  const r = p.relative(root, p.resolve(abs));
  if (escapesRoot(r, p)) return null;
  return r.split(p.sep).join('/');
}

/**
 * Watcher filename → workspace-relative hint. On Windows ReadDirectoryChangesW also reports alternate
 * data streams ("dl.zip:Zone.Identifier" when a browser saves a download): that is a change of the file.
 */
export function watchHint(filename: string, p: PlatformPath, win: boolean): string {
  let rel = filename.split(p.sep).join('/').replace(/^\/+/, '');
  if (win) rel = rel.replace(/:[^/]*$/, '');
  return rel;
}
