// Bookmarks (the sidebar's Bookmarks panel, src/renderer/bookmarks): one list per workspace folder, kept in One's
// app data (`<app data>/bookmarks/<folder id>.json`, never in the folder itself). Pure, shared by both sides: the
// backend applies each change to the list as it is on disk (desktop and browser mode share the file), the
// renderer applies the same change at once and takes the backend's answer.
import { basename, dirname } from './paths';

export interface Bookmark {
  /** Workspace-relative POSIX path of a file or folder, spelled as the tree spells it. */
  path: string;
  /** The user's name for the bookmark (renames the bookmark, not the file). */
  label?: string;
}

/** `before`: insert in front of that bookmark; missing / unknown = at the end. */
export type BookmarkOp =
  | { op: 'add'; paths: string[]; before?: string }
  | { op: 'remove'; paths: string[] }
  | { op: 'move'; paths: string[]; before?: string }
  | { op: 'label'; path: string; label: string }
  /** A file or folder moved / was renamed: it and everything bookmarked inside it follow. */
  | { op: 'rename'; from: string; to: string };

export const MAX_BOOKMARKS = 500;
const MAX_LABEL = 120;
const MAX_PATH = 1024;
const MAX_OP_PATHS = 1000;

/** The one path rule: relative, `/`-separated, no `.` / `..` / empty segments, no backslash, drive or control
 *  character. Anything else is not a workspace path (bookmarks never touch the disk, but the file stays clean). */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p)) return null;
  return p.split('/').some((s) => !s || s === '.' || s === '..') ? null : p;
}

function cleanLabel(l: unknown): string | undefined {
  if (typeof l !== 'string') return undefined;
  const t = l.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LABEL);
  return t || undefined;
}

/** A stored or received list: valid entries only, first one wins on duplicates, at most MAX_BOOKMARKS. */
export function cleanList(v: unknown): Bookmark[] {
  const out: Bookmark[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(v) ? v : []) {
    const path = cleanPath((x as Bookmark | null)?.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const label = cleanLabel((x as Bookmark).label);
    out.push(label ? { path, label } : { path });
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

const paths = (v: unknown): string[] | null => {
  if (!Array.isArray(v) || v.length > MAX_OP_PATHS) return null;
  const out = v.map(cleanPath);
  return out.every((p): p is string => p !== null) ? out : null;
};

/** A change sent by a page: only the known shapes, every path through cleanPath. null = refuse. */
export function cleanOp(v: unknown): BookmarkOp | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const before = o.before === undefined ? undefined : cleanPath(o.before);
  if (before === null) return null;
  if (o.op === 'add' || o.op === 'move' || o.op === 'remove') {
    const ps = paths(o.paths);
    if (!ps) return null;
    return o.op === 'remove' ? { op: 'remove', paths: ps } : { op: o.op, paths: ps, ...(before ? { before } : {}) };
  }
  if (o.op === 'label') {
    const path = cleanPath(o.path);
    return path && typeof o.label === 'string' ? { op: 'label', path, label: o.label } : null;
  }
  if (o.op === 'rename') {
    const from = cleanPath(o.from);
    const to = cleanPath(o.to);
    return from && to ? { op: 'rename', from, to } : null;
  }
  return null;
}

/** `p` is `root` or inside it. */
export const isUnder = (p: string, root: string) => p === root || p.startsWith(root + '/');
/** `p` re-rooted from `from` to `to` (p must be under `from`). */
export const movedPath = (p: string, from: string, to: string) => to + p.slice(from.length);

function insert(list: Bookmark[], items: Bookmark[], before?: string): Bookmark[] {
  const at = before ? list.findIndex((b) => b.path === before) : -1;
  return at < 0 ? [...list, ...items] : [...list.slice(0, at), ...items, ...list.slice(at)];
}

/** The list after `op`. Never mutates; ids that are not bookmarked are ignored. */
export function applyOp(list: Bookmark[], op: BookmarkOp): Bookmark[] {
  switch (op.op) {
    case 'add': {
      const have = new Set(list.map((b) => b.path));
      const fresh = [...new Set(op.paths)].filter((p) => !have.has(p)).map((path) => ({ path }));
      return insert(list, fresh, op.before).slice(0, MAX_BOOKMARKS);
    }
    case 'remove': {
      const gone = new Set(op.paths);
      return list.filter((b) => !gone.has(b.path));
    }
    case 'move': {
      const moving = new Set(op.paths);
      const items = list.filter((b) => moving.has(b.path));
      // Dropping in front of one of the moved items: in front of the first unmoved one after it.
      let before = op.before;
      if (before && moving.has(before)) before = list.slice(list.findIndex((b) => b.path === before)).find((b) => !moving.has(b.path))?.path;
      return insert(
        list.filter((b) => !moving.has(b.path)),
        items,
        before,
      );
    }
    case 'label': {
      const label = cleanLabel(op.label);
      return list.map((b) => (b.path !== op.path ? b : label ? { path: b.path, label } : { path: b.path }));
    }
    case 'rename': {
      if (op.from === op.to || !list.some((b) => isUnder(b.path, op.from))) return list;
      const moved = list.map((b) => (isUnder(b.path, op.from) ? { ...b, path: movedPath(b.path, op.from, op.to) } : b));
      return cleanList(moved); // a move onto something already bookmarked: the first entry stays
    }
  }
}

interface FsEventLike {
  type: string;
  path: string;
}

/**
 * Moves a watcher batch most likely holds for the bookmarked `targets` (an outside rename arrives as unlink + add:
 * the watcher cannot tell). A removed entry that is a target or holds one has moved when the same batch adds
 *   · exactly one entry of the same kind and name elsewhere (moved to another folder), or
 *   · exactly one entry of the same kind in the same folder, while exactly one of that kind went there (renamed).
 * Top-most removed entries first, so a renamed folder carries what is bookmarked inside it.
 */
export function fsMoves(targets: readonly string[], events: readonly FsEventLike[]): Array<{ from: string; to: string }> {
  const gone = events.filter((e) => e.type === 'unlink' || e.type === 'unlinkDir');
  const added = events.filter((e) => e.type === 'add' || e.type === 'addDir');
  if (!gone.length || !added.length) return [];
  const dir = (e: FsEventLike) => e.type.endsWith('Dir');
  const out: Array<{ from: string; to: string }> = [];
  for (const t of targets) {
    if (out.some((m) => isUnder(t, m.from))) continue;
    const roots = gone.filter((g) => isUnder(t, g.path)).sort((a, b) => a.path.length - b.path.length);
    for (const r of roots) {
      if (added.some((a) => a.path === r.path)) break; // replaced in place (an atomic save): still there
      const kin = added.filter((a) => dir(a) === dir(r) && a.path !== r.path);
      let to = kin.filter((a) => basename(a.path) === basename(r.path));
      if (to.length !== 1) {
        const here = (e: FsEventLike) => dirname(e.path) === dirname(r.path);
        to = gone.filter((g) => dir(g) === dir(r) && here(g)).length === 1 ? kin.filter(here) : [];
      }
      if (to.length === 1) {
        out.push({ from: r.path, to: to[0].path });
        break;
      }
    }
  }
  return out;
}
