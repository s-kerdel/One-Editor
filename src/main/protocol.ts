// Pure helpers for the Electron main process (no electron import), so the URL / argv rules are
// unit-tested — including Windows paths via path.win32.
type PlatformPath = typeof import('node:path').posix;
import { escapesRoot } from '../backend/pathsafe';
export { isExternalUrl } from '../shared/api';

export const SCHEME = 'app';
export const HOST = 'sec-edit';
export const APP_ORIGIN = `${SCHEME}://${HOST}`;
/** Workspace files for the preview live under this prefix (served sandboxed): /__ws/<window key>/<rel>. */
export const WS_PREFIX = '/__ws/';
/** Text pages for the search workers (they fetch them directly: never through the UI thread). */
export const INDEX_PREFIX = '/__index/';
/** PDF export documents: their own host (never "the app", so never a trusted IPC sender) in their own session. */
export const PDF_HOST = 'sec-edit-pdf';

/** Requests the hidden PDF window may make: its own document, inlined data and remote images (as the preview shows). */
export function isPdfWindowRequestAllowed(url: string, resourceType: string): boolean {
  if (url.startsWith('data:')) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${SCHEME}:`) return u.host === PDF_HOST && resourceType === 'mainFrame';
  return u.protocol === 'https:' && resourceType === 'image';
}

export type AppRoute =
  /** `key`: the window's ws key (several windows: each serves its own folder, main/main.ts). */
  | { kind: 'workspace'; key: string; rel: string }
  | { kind: 'index'; op: 'page' | 'files'; params: URLSearchParams }
  | { kind: 'renderer'; file: string }
  | { kind: 'error'; status: number; message: string };

/** app://sec-edit/<path> → which file to serve. Workspace paths are validated later by Workspace.abs(). */
export function routeAppUrl(rawUrl: string, rendererDir: string, p: PlatformPath): AppRoute {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: 'error', status: 400, message: 'bad url' };
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return { kind: 'error', status: 404, message: 'not found' };
  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname); // malformed %-escapes must be a 400, not an unhandled throw
  } catch {
    return { kind: 'error', status: 400, message: 'bad url' };
  }
  if (pathname.startsWith(WS_PREFIX)) {
    // The first segment names the window; no key segment = no window (never "the" folder).
    const rest = pathname.slice(WS_PREFIX.length);
    const cut = rest.indexOf('/');
    if (cut <= 0) return { kind: 'error', status: 404, message: 'not found' };
    return { kind: 'workspace', key: rest.slice(0, cut), rel: rest.slice(cut + 1) };
  }
  if (pathname.startsWith(INDEX_PREFIX)) {
    const op = pathname.slice(INDEX_PREFIX.length);
    return op === 'page' || op === 'files' ? { kind: 'index', op, params: u.searchParams } : { kind: 'error', status: 404, message: 'not found' };
  }
  const root = p.resolve(rendererDir);
  const file = p.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (file !== root && escapesRoot(p.relative(root, file), p)) return { kind: 'error', status: 403, message: 'forbidden' };
  return { kind: 'renderer', file };
}

/**
 * May the main frame navigate to `url`? Only to the app itself — never to a workspace file
 * (`app://sec-edit/__ws/x.html` would replace the app, unsaved edits included) or anywhere else.
 */
export function isAppNavigation(url: string, devServerUrl?: string): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.host === HOST && !decodeURIComponent(u.pathname).startsWith(WS_PREFIX);
  } catch {
    return false;
  }
}

export interface ArgvOptions {
  cwd: string;
  /** Unpackaged runs: argv is [electron, <appDir>, ...]; everything up to the app dir is skipped. */
  appPath: string | null;
  exists: (abs: string) => boolean;
  p: PlatformPath;
  foldCase: boolean;
}

/** argv → existing absolute paths. Skips the exe, Chromium/Squirrel switches and (unpackaged) the app dir. */
export function pathsFromArgs(argv: string[], o: ArgvOptions): string[] {
  const win = o.p.sep === '\\';
  const fold = (s: string) => (o.foldCase ? s.toLowerCase() : s);
  let rest = argv.slice(1).filter((a) => !!a && !a.startsWith('-'));
  if (o.appPath) {
    const app = fold(o.p.resolve(o.appPath));
    const i = rest.findIndex((a) => fold(o.p.resolve(o.cwd, a)) === app);
    rest = i === -1 ? rest : rest.slice(i + 1);
  }
  const clean = (a: string) => {
    if (!win) return a;
    // Explorer's "%1" for a drive root is "C:\" — and CommandLineToArgvW reads \" as a literal quote → `C:"`.
    let s = a.replace(/"+$/, '');
    if (/^[a-z]:$/i.test(s)) s += '\\';
    return s;
  };
  return rest.map((a) => o.p.resolve(o.cwd, clean(a))).filter((x) => o.exists(x));
}

/**
 * A file handed to the app (argv, Finder "Open With", second instance, drop) never moves an open folder: it opens as a
 * tab in it (the renderer decides what to do with one outside the folder). Only with NO folder open does the old rule
 * apply: the most recent existing folder that contains it, else its own folder. Returns the folder to open, or null
 * to keep the current one.
 */
export function folderForOpenedFile(o: { current: string | null; file: string; recents: string[]; isInside: (child: string, parent: string) => boolean; exists: (dir: string) => boolean; dirname: (p: string) => string }): string | null {
  if (o.current) return null;
  return o.recents.find((r) => o.isInside(o.file, r) && o.exists(r)) ?? o.dirname(o.file);
}
