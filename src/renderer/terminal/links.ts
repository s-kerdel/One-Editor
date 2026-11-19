// Clickable file paths in terminal output: `src/a.ts:12:3`, `C:\x\y.php(14)`, `./notes/a.md`,
// `File "a.py", line 3`, `in C:\x\y.php on line 14`, `/home/me/proj/a.ts` (also from a WSL or
// Git Bash shell when the folder is open on Windows). Pure: tested without xterm.
import { wslUncInfo } from '@shared/terminal';

export interface PathCandidate {
  /** UTF-16 offsets into the line text; `end` includes the :line:col suffix. */
  start: number;
  end: number;
  path: string;
  /** 1-based, as printed. */
  line?: number;
  col?: number;
}

// Optional root (drive, UNC, ./, ../, ~/, /) then characters that occur in paths but not around them.
const TOKEN = /(?:[A-Za-z]:[\\/]|[\\/]{2}|\.{1,2}[\\/]|~[\\/]|[\\/])?[^\s"'`<>|*?(){}[\],;:]+/g;
const SUFFIXES: RegExp[] = [
  /^:(\d+)(?::(\d+))?/, // a.ts:12:3  a.ts:12
  /^\((\d+)(?:,\s*(\d+))?\)/, // a.ts(12,3)  a.php(14)
  /^:line (\d+)/, // .NET: a.cs:line 42
  /^",? line (\d+)(?:, column (\d+))?/, // Python: "a.py", line 3
  /^ on line (\d+)/, // PHP: a.php on line 14
];

export function findPathCandidates(text: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  if (text.length > 4000) text = text.slice(0, 4000); // pathological lines: links stop, the terminal doesn't
  for (const m of text.matchAll(TOKEN)) {
    let raw = m[0];
    const start = m.index!;
    raw = raw.replace(/\.+$/, ''); // "see src/a.ts." → the sentence's full stop is not part of the name
    if (raw.length < 2 || raw.length > 1024) continue;
    // A path needs a separator or an extension: plain words are never links.
    if (!/[\\/]/.test(raw) && !/[^.]\.[\w-]*[A-Za-z][\w-]*$/.test(raw)) continue;
    if (/^v?\d+(\.\d+)*$/.test(raw) || /^[a-z][\w+.-]*:\/\//i.test(text.slice(start))) continue; // versions, URLs
    let end = start + raw.length;
    const c: PathCandidate = { start, end, path: raw };
    if (end === start + m[0].length) {
      const rest = text.slice(end, end + 40);
      for (const re of SUFFIXES) {
        const s = re.exec(rest);
        if (!s) continue;
        c.line = Number(s[1]);
        if (s[2]) c.col = Number(s[2]);
        end += re === SUFFIXES[3] ? 0 : s[0].length; // python: the quote ends the link
        break;
      }
    }
    c.end = end;
    out.push(c);
  }
  return out;
}

export interface LinkContext {
  /** Absolute workspace root as the backend reports it (native separators). */
  root: string;
  /** Backend platform ('win32' | 'darwin' | 'linux'). */
  os: string;
  /** Workspace-relative POSIX paths of every file. */
  files: ReadonlySet<string>;
  /** Workspace-relative folder the shell started in. */
  cwd?: string;
}

/** a/b/../c → a/c; null when it climbs above the root. */
function cleanRel(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/** abs under base (both '/'-separated) → relative rest, else null. */
function under(abs: string, base: string, fold: boolean): string | null {
  const a = fold ? abs.toLowerCase() : abs;
  const b = (fold ? base.toLowerCase() : base).replace(/\/+$/, '');
  if (a === b) return '';
  return a.startsWith(b + '/') ? abs.slice(b.length + 1) : null;
}

const lowerIndex = new WeakMap<ReadonlySet<string>, Map<string, string>>();
function lookup(files: ReadonlySet<string>, rel: string, fold: boolean): string | null {
  if (files.has(rel)) return rel;
  if (!fold) return null;
  let idx = lowerIndex.get(files);
  if (!idx) {
    idx = new Map();
    for (const f of files) idx.set(f.toLowerCase(), f);
    lowerIndex.set(files, idx);
  }
  return idx.get(rel.toLowerCase()) ?? null;
}

/** A path printed by a shell → the workspace file it names (exists in `files`), or null. */
export function resolveLinkPath(raw: string, ctx: LinkContext): string | null {
  const fold = ctx.os !== 'linux'; // NTFS / APFS are case-insensitive by default
  const p = raw.replace(/\\/g, '/');
  const root = ctx.root.replace(/\\/g, '/');
  const winRoot = /^[A-Za-z]:\//.test(root);
  let rel: string | null = null;
  if (/^[A-Za-z]:\//.test(p) || /^\/\/[^/]/.test(p)) {
    rel = under(p, root, true); // Windows drive / UNC path
  } else if (p.startsWith('/')) {
    const wsl = wslUncInfo(ctx.root);
    if (wsl) rel = under(p, wsl.linuxPath, false) ?? (wsl.linuxPath === '/' ? p.slice(1) : null);
    else if (winRoot) {
      // Git Bash prints /c/Users/…, WSL on a Windows drive /mnt/c/Users/…
      const m = /^(?:\/mnt)?\/([a-z])(\/.*)$/i.exec(p);
      if (m) rel = under(`${m[1]}:${m[2]}`, root, true);
    } else rel = under(p, root, fold);
  } else if (!p.startsWith('~')) {
    const fromCwd = ctx.cwd ? cleanRel(`${ctx.cwd}/${p}`) : null;
    const hit = fromCwd !== null ? lookup(ctx.files, fromCwd, fold) : null;
    if (hit) return hit;
    rel = p; // the shell may have cd'd back to the root
  }
  if (rel === null) return null;
  const clean = cleanRel(rel);
  return clean ? lookup(ctx.files, clean, fold) : null;
}
