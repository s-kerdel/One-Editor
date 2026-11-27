// Several windows in one main process: the window list, which window a launched folder / file goes to
// (argv, second instance, macOS open-file), and where a new window appears.
// No electron import: unit-tested, Windows paths included (path.win32).
type PlatformPath = typeof import('node:path').posix;
import { folderForOpenedFile } from './protocol';
import { isInsideDir } from '../backend/pathsafe';

export interface RegistryOptions {
  p: PlatformPath;
  /** Platform default when comparing folders. An entry's own `foldsCase` (its backend's case rule) wins. */
  foldCase: boolean;
}

/** Open windows by id, by folder and by focus. `root` may be a getter (the window's backend.root). */
export class WindowRegistry<T extends { id: number; root: string | null; foldsCase?: boolean }> {
  private readonly byId = new Map<number, T>();
  /** Most recently focused first. */
  private focus: number[] = [];

  constructor(private readonly o: RegistryOptions) {}

  add(w: T): T {
    this.byId.set(w.id, w);
    return w;
  }

  remove(id: number): boolean {
    this.focus = this.focus.filter((x) => x !== id);
    return this.byId.delete(id);
  }

  get(id: number): T | undefined {
    return this.byId.get(id);
  }

  /** In the order they were added. */
  all(): T[] {
    return [...this.byId.values()];
  }

  /** The window that has this folder open. */
  byRoot(abs: string): T | undefined {
    return this.all().find((w) => w.root !== null && this.samePath(w.root, abs, w.foldsCase));
  }

  /** Same folder (trailing separators ignored); also planLaunch's `samePath`. */
  samePath(a: string, b: string, foldCase = this.o.foldCase): boolean {
    const x = this.o.p.resolve(a);
    const y = this.o.p.resolve(b);
    return foldCase ? x.toLowerCase() === y.toLowerCase() : x === y;
  }

  noteFocus(id: number): void {
    if (this.byId.has(id)) this.focus = [id, ...this.focus.filter((x) => x !== id)];
  }

  /** The most recently focused window; none focused yet → the newest. */
  lastFocused(): T | undefined {
    for (const id of this.focus) {
      const w = this.byId.get(id);
      if (w) return w;
    }
    return this.all().at(-1);
  }

  /** Open folders, each once (web server: stop when its folder is closed everywhere). */
  roots(): string[] {
    const out: string[] = [];
    for (const w of this.byId.values()) if (w.root !== null && !out.some((r) => this.samePath(r, w.root!, w.foldsCase))) out.push(w.root);
    return out;
  }
}

/**
 * Folder identity for routing: the same spelling (resolved, case rule) or the same real path. `real` = what main knows
 * of a path's real form (a symlink's / mapped drive's target: each window's root after its open, the launched paths);
 * unknown → the spelling only. The gate judges real paths too: a second spelling of an open folder is that folder.
 * `foldCase` per call: a window's own case rule (its backend's), else the platform's.
 */
export function folderMatch(o: { p: PlatformPath; foldCase: boolean; real: (abs: string) => string | null | undefined }) {
  const forms = (x: string) => {
    const r = o.real(x);
    return r && r !== x ? [x, r] : [x];
  };
  const norm = (x: string, fold: boolean) => (fold ? o.p.resolve(x).toLowerCase() : o.p.resolve(x));
  return {
    samePath: (a: string, b: string, foldCase = o.foldCase) => forms(a).some((x) => forms(b).some((y) => norm(x, foldCase) === norm(y, foldCase))),
    isInside: (child: string, parent: string, foldCase = o.foldCase) => forms(child).some((x) => forms(parent).some((y) => isInsideDir(o.p.resolve(x), o.p.resolve(y), o.p, foldCase))),
  };
}

export interface LaunchPath {
  abs: string;
  kind: 'dir' | 'file';
}

export interface LaunchInput {
  /** Existing absolute paths, in launch order. */
  paths: LaunchPath[];
  /** Open windows (registry order); `foldsCase` = the window's own case rule (undefined: the platform's). */
  windows: { id: number; root: string | null; foldsCase?: boolean }[];
  lastFocusedId: number | null;
  recents: string[];
  /** The app process just started: no paths → the most recent folder (as one window always did). */
  firstLaunch: boolean;
  /** `foldCase`: a window's own case rule when comparing with its folder; omitted = the platform's. */
  isInside: (child: string, parent: string, foldCase?: boolean) => boolean;
  samePath: (a: string, b: string, foldCase?: boolean) => boolean;
  exists: (dir: string) => boolean;
  dirname: (p: string) => string;
}

export type LaunchStep =
  | { kind: 'focus'; id: number }
  /** Brings the window to the front too. */
  | { kind: 'open-files'; id: number; files: string[] }
  | { kind: 'new-window'; folder: string | null; files: string[] };

/**
 * Where each launched path goes. One step per window, in the order the launch first reached it (the last one ends up in front).
 *  - folder: the window that has it open comes to the front, else a new window;
 *  - file: the window whose folder contains it (deepest wins; folders this launch opens count), else — an outside file —
 *    the window this launch brings to the front (its last folder / contained file), else the last focused window;
 *    no window at all: a new window, folder by folderForOpenedFile (a recent folder that contains it, else its own folder);
 *  - nothing: first launch → the most recent folder; later → a new window with the start screen.
 */
export function planLaunch(o: LaunchInput): LaunchStep[] {
  const windowOf = (folder: string) => o.windows.find((w) => w.root !== null && o.samePath(w.root, folder, w.foldsCase));
  if (!o.paths.length) {
    const folder = o.firstLaunch ? (o.recents[0] ?? null) : null;
    const open = folder === null ? undefined : windowOf(folder);
    return [open ? { kind: 'focus', id: open.id } : { kind: 'new-window', folder, files: [] }];
  }

  // id: an open window; null: a new one for `folder`. order: the first launch path that reached it.
  type Target = { id: number | null; folder: string | null; files: string[]; order: number };
  const targets: Target[] = [];
  // The window this launch brings to the front so far: the one its latest folder / file went to.
  const front: { t: Target | null; at: number } = { t: null, at: -1 };
  const reach = (t: Target, at: number, file?: string) => {
    t.order = Math.min(t.order, at);
    if (file !== undefined && !t.files.some((f) => o.samePath(f, file))) t.files.push(file);
    if (at >= front.at) Object.assign(front, { t, at });
  };
  const add = (t: Target) => (targets.push(t), t);
  const openTarget = (id: number) => targets.find((t) => t.id === id) ?? add({ id, folder: null, files: [], order: Infinity });
  const newTarget = (folder: string) => targets.find((t) => t.id === null && t.folder !== null && o.samePath(t.folder, folder)) ?? add({ id: null, folder, files: [], order: Infinity });

  // Folders first: a file of this launch joins a window the same launch opens.
  o.paths.forEach((x, i) => {
    if (x.kind !== 'dir') return;
    const w = windowOf(x.abs);
    reach(w ? openTarget(w.id) : newTarget(x.abs), i);
  });

  // Where a file can go: open windows (their own case rule) and the folders this launch opens.
  const homes = [
    ...o.windows.flatMap((w) => (w.root === null ? [] : [{ root: w.root, fold: w.foldsCase, target: () => openTarget(w.id) }])),
    ...targets.flatMap((t) => (t.id === null && t.folder !== null ? [{ root: t.folder, fold: undefined, target: () => t }] : [])),
  ];
  const outside: { abs: string; at: number }[] = [];
  o.paths.forEach((x, i) => {
    if (x.kind !== 'file') return;
    const inside = homes.filter((h) => o.isInside(x.abs, h.root, h.fold));
    if (!inside.length) return void outside.push({ abs: x.abs, at: i });
    const deepest = inside.reduce((best, h) => (!o.samePath(h.root, best.root) && o.isInside(h.root, best.root) ? h : best));
    reach(deepest.target(), i, x.abs);
  });

  const focused = o.windows.find((w) => w.id === o.lastFocusedId) ?? o.windows.at(-1);
  for (const f of outside) {
    const t = front.t ?? (focused ? openTarget(focused.id) : newTarget(folderForOpenedFile({ current: null, file: f.abs, recents: o.recents, isInside: o.isInside, exists: o.exists, dirname: o.dirname }) ?? o.dirname(f.abs)));
    reach(t, f.at, f.abs);
  }

  return targets
    .sort((a, b) => a.order - b.order)
    .map((t): LaunchStep => (t.id === null ? { kind: 'new-window', folder: t.folder, files: t.files } : t.files.length ? { kind: 'open-files', id: t.id, files: t.files } : { kind: 'focus', id: t.id }));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The next window: `step` px right of and below the previous one (its normal bounds, not maximised), same size
 * (at most the work area); back to the work area's top-left corner when it would leave the work area.
 */
export function cascadeBounds(prev: Rect, workArea: Rect, step = 32): Rect {
  const width = Math.min(prev.width, workArea.width);
  const height = Math.min(prev.height, workArea.height);
  const x = prev.x + step;
  const y = prev.y + step;
  const fits = x >= workArea.x && y >= workArea.y && x + width <= workArea.x + workArea.width && y + height <= workArea.y + workArea.height;
  return fits ? { x, y, width, height } : { x: workArea.x, y: workArea.y, width, height };
}
