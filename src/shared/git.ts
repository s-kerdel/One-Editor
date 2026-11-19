// Read-only git contract (tier 1) shared by the backend git service and the renderer.
// Paths are workspace-relative POSIX like everything else crossing the backend boundary.

/** What the file tree shows for one path. */
export type GitFileState = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflicted' | 'ignored';

export interface GitEntry {
  /** Workspace-relative path (a directory entry has no trailing slash, see `dir`). */
  path: string;
  state: GitFileState;
  /** Index differs from HEAD. */
  staged?: boolean;
  /** Working tree differs from the index. */
  unstaged?: boolean;
  /** Renames/copies: the previous path (null when it lies outside the workspace). */
  from?: string | null;
  /** An untracked / ignored folder reported as one entry: everything below it shares the state. */
  dir?: boolean;
  /** Submodule, shown as one entry. */
  submodule?: boolean;
}

export interface GitBranch {
  /** Branch name; null when detached. */
  head: string | null;
  /** HEAD commit; null before the first commit. */
  oid: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  ok: true;
  branch: GitBranch;
  entries: GitEntry[];
  /** Workspace folder relative to the repository root ('' = the workspace is the repo root). */
  prefix: string;
  /** Too many entries: the list was cut (the tree just shows fewer marks). */
  truncated?: boolean;
  /** git took this long (ms). */
  ms: number;
  /** A merge / rebase / cherry-pick / revert is in progress. */
  state?: GitRepoState;
}

export type GitUnavailableReason =
  /** No git executable found. */
  | 'no-git'
  /** The folder is not inside a work tree. */
  | 'no-repo'
  /** git refused the repository (safe.directory / dubious ownership). */
  | 'unsafe'
  | 'timeout'
  | 'error';

export interface GitUnavailable {
  ok: false;
  reason: GitUnavailableReason;
  message?: string;
  /** 'no-git' only: a `.git` exists here or above, so a hint "install git" is worth showing. */
  repoLikely?: boolean;
}

export type GitStatusResult = GitStatus | GitUnavailable;

/** A file's content at a commit (default HEAD), decoded + LF-normalised like the editor's buffers. */
export interface GitHeadFile {
  /** null: not in that commit (untracked / new), or not comparable (binary, too large, LFS pointer). */
  content: string | null;
  /** Commit the content was read from (null: no commits yet / no repo). */
  oid: string | null;
  binary?: boolean;
  tooLarge?: boolean;
  /** Git LFS pointer: the real content is not in the repository. */
  lfs?: boolean;
}

/** Revisions the renderer may ask for: HEAD or a full object id. Never a free-form revision (option injection). */
export const GIT_REV_RE = /^(HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/;

// ---- tier 2: source control ------------------------------------------------------------------

/** Something git is in the middle of (shown as a banner; finishing it is up to the user). */
export type GitRepoState = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface GitActionResult {
  ok: boolean;
  /** What went wrong (or git's summary on success), first useful lines of its output. */
  message?: string;
  /** Needs credentials / a passphrase / a decision we will not take: the same command, for a terminal. */
  terminal?: string;
  /** Network auth was the problem (credentials, SSH key, host key). */
  auth?: boolean;
}

export interface GitBranchInfo {
  /** Short name: "main", "origin/main". */
  name: string;
  remote: boolean;
  current: boolean;
  /** Abbreviated commit id. */
  oid: string;
  upstream: string | null;
  /** Seconds since the epoch. */
  date: number;
  subject: string;
}

/** Why a background (low-priority) list came back without its rows. */
export type GitJobError = 'timeout' | 'cancelled' | 'failed';

export interface GitBranchList {
  /** Most recently committed first (capped: see `truncated`). Ahead/behind: only for the current branch, in the status. */
  branches: GitBranchInfo[];
  remotes: string[];
  truncated?: boolean;
  error?: GitJobError;
  message?: string;
}

/** One page of history. */
export interface GitLogPage {
  commits: GitCommit[];
  /** More commits after this page. */
  more: boolean;
  error?: GitJobError;
  message?: string;
}

/** One changed block of a text comparison (0-based lines). */
export interface GitTextHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** "Compare text": git's diff of two texts, or `none` when git could not do it (use a built-in diff). */
export type GitTextDiff = { engine: 'git'; hunks: GitTextHunk[]; patch: string } | { engine: 'none'; reason: string };

/** Background lists the renderer may cancel (section collapsed, pane closed). */
export type GitJobTag = 'branches' | 'history' | 'files';

export interface GitCommit {
  oid: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the epoch. */
  date: number;
  subject: string;
}

export interface GitCommitFile {
  /** Workspace-relative path (new name for renames). */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  /** Renames: old name (null when outside the workspace). */
  from?: string | null;
}

export interface GitCommitFiles {
  oid: string;
  /** First parent (null for the root commit). */
  parent: string | null;
  files: GitCommitFile[];
  error?: GitJobError;
  message?: string;
}

/** Every operation behind the single `git(op, ...args)` RPC. Mutating ones validate every path. */
export interface GitOps {
  status(): GitStatusResult;
  headFile(path: string, rev?: string): GitHeadFile;
  diff(path: string, rev?: string): string | null;
  /** null = everything in the workspace. */
  stage(paths: string[] | null): GitActionResult;
  unstage(paths: string[] | null): GitActionResult;
  /** Work-tree changes back to the index; untracked files go to the trash. */
  discard(paths: string[]): GitActionResult;
  commit(opts: { message: string; amend?: boolean }): GitActionResult;
  lastMessage(): string;
  fetch(): GitActionResult;
  pull(): GitActionResult;
  push(): GitActionResult;
  branches(): GitBranchList;
  createBranch(name: string): GitActionResult;
  switchBranch(name: string): GitActionResult;
  log(opts?: { skip?: number; limit?: number }): GitLogPage;
  /** `parent`: the commit's first parent when the caller knows it (saves a spawn); null = root commit. */
  commitFiles(oid: string, parent?: string | null): GitCommitFiles;
  /** Stop queued / running background jobs with this tag (all when omitted). */
  cancel(tag?: GitJobTag): void;
  /** Two texts through `git diff --no-index --histogram` (≤ 5 MB each). Needs git, not a repository. */
  diffTexts(a: string, b: string, opts?: { ignoreWhitespace?: boolean }): GitTextDiff;
}
export type GitOp = keyof GitOps;
export const GIT_OPS: readonly GitOp[] = ['status', 'headFile', 'diff', 'stage', 'unstage', 'discard', 'commit', 'lastMessage', 'fetch', 'pull', 'push', 'branches', 'createBranch', 'switchBranch', 'log', 'commitFiles', 'cancel', 'diffTexts'];
