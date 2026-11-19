// File-tree decorations from a git status: per-file marks, folder roll-up ("contains changes" dot),
// inheritance from untracked / ignored folders, and the "show changes only" tree. Pure, no DOM.
import type { TreeNode } from '@shared/api';
import type { GitEntry, GitFileState } from '@shared/git';

export interface FileMark {
  state: GitFileState;
  /** One-letter badge ('' for ignored: those are only dimmed). */
  letter: string;
  title: string;
  /** Rename source. */
  from?: string | null;
  submodule?: boolean;
  staged?: boolean;
  unstaged?: boolean;
}

export interface DirMark {
  /** The folder itself is untracked / ignored (everything inside shares it). */
  own?: FileMark;
  /** Most important change somewhere below (drives the dot colour). */
  worst?: GitFileState;
  /** Changed entries below (not counting ignored). */
  count: number;
}

export interface GitMarks {
  file(path: string): FileMark | null;
  dir(path: string): DirMark | null;
  /** Changed (non-ignored) entry paths, files and untracked folders. */
  readonly changed: readonly string[];
  /** Deleted paths (not on disk, so not in the tree). */
  readonly deleted: readonly string[];
  /** Number of changed (non-ignored) entries. */
  readonly count: number;
}

const LETTER: Record<GitFileState, string> = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', renamed: 'R', conflicted: '!', ignored: '' };
const LABEL: Record<GitFileState, string> = {
  modified: 'Modified',
  added: 'Added',
  untracked: 'Untracked',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Merge conflict',
  ignored: 'Ignored by git',
};
/** Folder dot priority. */
const RANK: Record<GitFileState, number> = { conflicted: 5, deleted: 3, modified: 3, renamed: 3, added: 2, untracked: 1, ignored: 0 };

export function markOf(e: GitEntry): FileMark {
  let title = LABEL[e.state];
  if (e.state === 'renamed' && e.from) title += ` from ${e.from}`;
  if (e.submodule) title = `Submodule · ${title.toLowerCase()}`;
  if (e.state !== 'untracked' && e.state !== 'ignored' && e.state !== 'conflicted') {
    if (e.staged && e.unstaged) title += ' · partly staged';
    else if (e.staged) title += ' · staged';
  }
  const m: FileMark = { state: e.state, letter: LETTER[e.state], title };
  if (e.from !== undefined) m.from = e.from;
  if (e.submodule) m.submodule = true;
  if (e.staged) m.staged = true;
  if (e.unstaged) m.unstaged = true;
  return m;
}

const parentOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};

export const EMPTY_MARKS: GitMarks = { file: () => null, dir: () => null, changed: [], deleted: [], count: 0 };

/** `foldCase`: case-insensitive lookups (Windows / macOS file systems). */
export function buildMarks(entries: readonly GitEntry[], opts: { foldCase?: boolean } = {}): GitMarks {
  if (!entries.length) return EMPTY_MARKS;
  const key = opts.foldCase ? (p: string) => p.toLowerCase() : (p: string) => p;
  const files = new Map<string, FileMark>();
  /** Untracked / ignored folders reported as one entry. */
  const covered = new Map<string, FileMark>();
  const dirs = new Map<string, DirMark>();
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const e of entries) {
    const mark = markOf(e);
    if (e.dir) covered.set(key(e.path), mark);
    else files.set(key(e.path), mark);
    if (e.state === 'ignored') continue;
    changed.push(e.path);
    if (e.state === 'deleted') deleted.push(e.path);
    // Roll up into every ancestor folder ('' = workspace root).
    if (!e.path) continue;
    for (let p = parentOf(e.path); ; p = parentOf(p)) {
      const k = key(p);
      const d = dirs.get(k) ?? { count: 0 };
      d.count++;
      if (!d.worst || RANK[e.state] > RANK[d.worst]) d.worst = e.state;
      dirs.set(k, d);
      if (!p) break;
    }
  }
  const inherited = (path: string): FileMark | null => {
    if (!covered.size) return null;
    for (let p = path; ; p = parentOf(p)) {
      const c = covered.get(key(p));
      if (c) return c;
      if (!p) return null;
    }
  };
  return {
    file: (path) => files.get(key(path)) ?? inherited(path),
    dir(path) {
      const own = inherited(path) ?? files.get(key(path)) ?? undefined; // submodules are folders with a file entry
      const d = dirs.get(key(path));
      if (!own && !d) return null;
      return own ? { ...d, count: d?.count ?? 0, own } : d!;
    },
    changed,
    deleted,
    count: changed.length,
  };
}

/** CSS class for a tree row ('' when unchanged). */
export function rowClass(marks: GitMarks, path: string, isDir: boolean): string {
  if (isDir) {
    const d = marks.dir(path);
    if (!d) return '';
    if (d.own) return ` se-git-${d.own.state}`;
    return d.count ? ' se-git-has-changes' : '';
  }
  const m = marks.file(path);
  return m ? ` se-git-${m.state}` : '';
}

/**
 * The tree reduced to changed files (and the folders holding them), for "Show changes".
 * Returns the folders kept, so the caller can show them expanded. Untracked folders are kept whole.
 */
export function changesTree(tree: TreeNode, marks: GitMarks): { tree: TreeNode; dirs: Set<string> } {
  const dirs = new Set<string>();
  const keep = (n: TreeNode, insideNew: boolean): TreeNode | null => {
    if (n.kind === 'file') {
      const m = insideNew ? true : marks.file(n.path);
      return m && (m === true || m.state !== 'ignored') ? n : null;
    }
    const d = n.path ? marks.dir(n.path) : null;
    if (d?.own?.state === 'ignored') return null;
    if (d?.own?.submodule) return n; // one entry: shown, but left collapsed
    const whole = insideNew || d?.own?.state === 'untracked';
    if (!whole && n.path && !d?.count) return null;
    const children = (n.children ?? []).map((c) => keep(c, whole)).filter((c): c is TreeNode => !!c);
    if (n.path && !children.length && !d?.own) return null;
    if (n.path) dirs.add(n.path);
    return { ...n, children };
  };
  return { tree: keep(tree, !!marks.dir('')?.own && marks.dir('')!.own!.state === 'untracked') ?? { ...tree, children: [] }, dirs };
}
