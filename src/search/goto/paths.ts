// Path rules for Go to definition. Every path it derives from file contents — composer.json,
// vendor/composer/autoload_psr4.php, import specifiers, PHP namespaces — is untrusted text from the
// opened folder. Before anything is read it must be a normalised workspace-relative POSIX path that
// stays inside the folder: no absolute paths, drive letters, UNC / backslashes, colons (drive, alternate
// data streams, URL schemes), control characters or NUL, no `..` above the root, no Windows device
// names, no segment ending in a dot or space. (The backend's `Workspace.real()` then refuses links leading out; this is the lexical half.)
// Attack table: tests/unit/search/goto-paths.test.ts.

const BAD_CHARS = /[\u0000-\u001f\u007f\\:]/;
// As backend/pathsafe.ts: device names also with blanks before an extension ("CON .txt", "nul.md").
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)\s*(\..*)?$/i;
const MAX_LEN = 1024;
const MAX_SEGMENTS = 64;

/** Normalised workspace-relative POSIX path, or null when it is absolute, leaves the folder or is malformed. */
export function safeRel(p: string): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_LEN || BAD_CHARS.test(p) || p.startsWith('/')) return null;
  const out: string[] = [];
  const segs = p.split('/');
  if (segs.length > MAX_SEGMENTS) return null;
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null; // above the workspace root
      out.pop();
      continue;
    }
    // Win32 strips trailing dots / spaces: "User.php." would be a second name for "User.php".
    if (/[. ]$/.test(seg) || DEVICE.test(seg)) return null;
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** `base` joined with relative `parts`, normalised; null when any part is absolute / malformed or the result leaves the folder. */
export function safeJoin(base: string, ...parts: string[]): string | null {
  for (const p of [base, ...parts]) {
    if (typeof p !== 'string' || p.length > MAX_LEN || BAD_CHARS.test(p) || p.startsWith('/')) return null;
  }
  return safeRel([base, ...parts].filter(Boolean).join('/'));
}

/** Folder of a workspace-relative path ('' = the root). */
export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
