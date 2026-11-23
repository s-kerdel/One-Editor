// "External file" identity: a file the user opened that lies outside the open folder (Finder "Open With", argv,
// drop, Open file…). Everything in the app keys documents by one string; for in-folder files that stays the
// workspace-relative POSIX path. An external file's string is EXT_PREFIX + its absolute path with forward slashes
// (`::ext:/Users/me/a.md`, `::ext:/C:/x/a.md`, `::ext://server/share/a.md`). The string is only a name: the backend
// serves it only if it is on the allow-list of files the user opened (backend/external-files.ts).
// Not indexed, not in git / search / MCP, not restored with the session.
export const EXT_PREFIX = '::ext:';

export const isExtPath = (p: string): boolean => typeof p === 'string' && p.startsWith(EXT_PREFIX);

/** Absolute native path → id. */
export function extIdOf(abs: string): string {
  return EXT_PREFIX + abs.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1');
}

/** id → absolute native path for the given platform, or null when it is malformed. */
export function extAbsOf(id: string, win: boolean): string | null {
  if (!isExtPath(id) || id.includes('\0')) return null;
  const rest = id.slice(EXT_PREFIX.length);
  if (!rest.startsWith('/')) return null;
  if (win) return /^\/[A-Za-z]:\//.test(rest) ? rest.slice(1).replace(/\//g, '\\') : rest.startsWith('//') ? rest.replace(/\//g, '\\') : null;
  return /^\/[A-Za-z]:\//.test(rest) ? null : rest;
}

/** The absolute path to show a person (tooltips): forward slashes, drive letter without the leading slash. */
export function extDisplay(id: string): string {
  return id.slice(EXT_PREFIX.length).replace(/^\/([A-Za-z]:\/)/, '$1');
}
