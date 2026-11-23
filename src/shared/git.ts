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
  /** Snapshot version (deltas are relative to it). */
  version?: number;
  /** Every repository in the folder (one, or several below a parent folder); entries are combined. */
  repos?: GitRepoInfo[];
}

export interface GitRepoInfo {
  /** Repository folder, workspace-relative ('' = the workspace is inside this repository). */
  rel: string;
  branch: GitBranch | null;
  state?: GitRepoState;
  /** 'wsl': git runs inside the WSL distro the folder lives in. */
  engine?: 'wsl' | 'native';
  /** The workspace folder inside the repository ('' or "docs/"). */
  prefix?: string;
  error?: GitUnavailableReason;
}

/** Only what changed since the renderer's version `base`. */
export interface GitStatusDelta {
  ok: true;
  delta: true;
  version: number;
  base: number;
  /** Added or changed entries. */
  set: GitEntry[];
  removed: string[];
  branch: GitBranch;
  prefix: string;
  ms: number;
  state?: GitRepoState;
  repos: GitRepoInfo[];
}

/** Nothing changed since the renderer's version. */
export interface GitStatusSame {
  ok: true;
  same: true;
  version: number;
}

export type GitStatusReply = GitStatusResult | GitStatusDelta | GitStatusSame;

export type GitUnavailableReason =
  /** No git executable found. */
  | 'no-git'
  /** The folder is not inside a work tree. */
  | 'no-repo'
  /** git refused the repository (safe.directory / dubious ownership). */
  | 'unsafe'
  /** The user has not said "Trust" for this folder yet: git is not run here at all (see backend/git-trust.ts). */
  | 'untrusted'
  | 'timeout'
  | 'error';

/**
 * THE sentence for "git was stopped after its time limit", on every surface (pane, status bar, toasts,
 * lists). The timeout itself travels as a code (`reason` / `error` / `timeout`), without a text of its
 * own: a surface shows this sentence once and never puts a prefix in front of a second wording.
 */
export const GIT_TIMEOUT_TEXT = "Git didn't answer in time.";

export interface GitUnavailable {
  ok: false;
  reason: GitUnavailableReason;
  /** git's own first line, for 'unsafe' / 'error' (a detail to show after the reason's sentence). Not set for 'timeout'. */
  message?: string;
  /** 'no-git': a `.git` exists here or above, so a hint "install git" is worth showing.
   *  'untrusted': a `.git` exists here, above or in a folder below (seen on disk, git was not asked). */
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
  /** git was stopped after its time limit (`message` is GIT_TIMEOUT_TEXT): the UI offers Retry, which reads
   *  the repository again and never runs the action again. */
  timeout?: boolean;
}

export interface GitBranchInfo {
  /** Short name: "main", "origin/main". */
  name: string;
  remote: boolean;
  current: boolean;
  /** Full commit id. */
  oid: string;
  upstream: string | null;
  /** Commit date (seconds since the epoch) and subject: filled in later (branchDetails). */
  date?: number;
  subject?: string;
}

/** Date + subject of a commit (branch rows). */
export interface GitCommitInfo {
  oid: string;
  date: number;
  subject: string;
}

export interface GitBranchDetails {
  details: GitCommitInfo[];
  error?: GitJobError;
  message?: string;
}

/** A window of remote branches (name-sorted, optionally filtered). */
export interface GitRemoteBranchPage {
  /** Matching remote branches in total. */
  total: number;
  /** From `offset`, at most `limit`. */
  items: Array<{ name: string; oid: string }>;
  error?: GitJobError;
  message?: string;
}

/** Why a background (low-priority) list came back without its rows. */
export type GitJobError = 'timeout' | 'cancelled' | 'failed';

export interface GitBranchList {
  /** Local branches, name-sorted, current first; no dates yet (branchDetails). Ahead/behind: the status. */
  branches: GitBranchInfo[];
  /** Remote names ("origin"). */
  remotes: string[];
  /** Remote-tracking branches (listed on demand: remoteBranches). */
  remoteCount: number;
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
export type GitJobTag = 'branches' | 'remotes' | 'history' | 'files';

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

// ---- choose what to commit (partial staging) ------------------------------------------------

/** One changed block of a file: HEAD lines [a0, a1) became working-copy lines [b0, b1) (0-based). */
export interface GitHunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  /** In the index (goes into the commit), not, or partly. */
  state: 'staged' | 'unstaged' | 'mixed';
}

/** A block from `hunks()` (by its ranges) to put into the commit (`include`) or take out. */
export interface GitHunkPick {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  include: boolean;
}

/** Why a file can only be staged as a whole. */
export type GitWholeFileReason = 'untracked' | 'added' | 'deleted' | 'conflicted' | 'binary' | 'too-large' | 'lfs' | 'filter' | 'special' | 'unchanged' | 'unavailable';

/** Texts are decoded + LF-normalised (what the diff view shows); the blocks' lines refer to them. */
export type GitFileHunks = { mode: 'hunks'; head: string; work: string; hunks: GitHunk[] } | { mode: 'file'; reason: GitWholeFileReason };

/** One tracked file that differs from the last commit (`numstat`): workspace-relative path + line counts (binary: 0 / 0). */
export interface GitNumstatRow {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

/** Every operation behind the single `git(op, ...args)` RPC. Mutating ones validate every path. */
export interface GitOps {
  /** `since`: the version the caller has (→ same / delta / full); `fresh`: run now (after an action). */
  status(opts?: { since?: number; fresh?: boolean }): GitStatusReply;
  /** Window focus / a file was opened: maybe look again (the backend decides, see GitMonitor). */
  nudge(kind: 'focus' | 'open'): void;
  /** Pause status runs while no window shows (one catch-up run on show). */
  visibility(client: string, visible: boolean): void;
  headFile(path: string, rev?: string): GitHeadFile;
  diff(path: string, rev?: string): string | null;
  /** Line counts of every tracked file that differs from HEAD (work tree, staged or not; untracked files are not
   *  listed), over every repository in the folder. null: no repository / no commit yet / not trusted. Read only. */
  numstat(): GitNumstatRow[] | null;
  // Path operations go to the repository that holds each path. Repository operations take `repo`: the
  // repository folder from `status().repos` ('' / omitted = the only or first repository).
  /** null = everything in `repo`. */
  stage(paths: string[] | null, repo?: string): GitActionResult;
  unstage(paths: string[] | null, repo?: string): GitActionResult;
  /** Work-tree changes back to the index; untracked files go to the trash. */
  discard(paths: string[]): GitActionResult;
  /** Blocks of HEAD → working copy with their staged state (`from`: the rename source from the status). */
  hunks(path: string, from?: string | null): GitFileHunks;
  /** Include / leave out blocks of `hunks()`: changes the index only (`git apply --cached`), never the file. */
  stageHunks(path: string, picks: GitHunkPick[], from?: string | null): GitActionResult;
  commit(opts: { message: string; amend?: boolean; repo?: string }): GitActionResult;
  lastMessage(repo?: string): string;
  fetch(repo?: string): GitActionResult;
  pull(repo?: string): GitActionResult;
  push(repo?: string): GitActionResult;
  /** Phase 1, instant: local branches + how many remote ones (no commit objects read). */
  branches(repo?: string): GitBranchList;
  /** Name-sorted remote branches, a window at a time (cached listing). */
  remoteBranches(opts?: { offset?: number; limit?: number; filter?: string; repo?: string }): GitRemoteBranchPage;
  /** Dates + subjects for these commits (background; `tag` decides what a cancel stops). */
  branchDetails(oids: string[], tag?: 'branches' | 'remotes', repo?: string): GitBranchDetails;
  createBranch(name: string, repo?: string): GitActionResult;
  switchBranch(name: string, repo?: string): GitActionResult;
  log(opts?: { skip?: number; limit?: number; repo?: string }): GitLogPage;
  /** `parent`: the commit's first parent when the caller knows it (saves a spawn); null = root commit. */
  commitFiles(oid: string, parent?: string | null, repo?: string): GitCommitFiles;
  /** Stop queued / running background jobs with this tag (all when omitted). */
  cancel(tag?: GitJobTag): void;
  /** Two texts through `git diff --no-index --histogram` (≤ 5 MB each). Needs git, not a repository. */
  diffTexts(a: string, b: string, opts?: { ignoreWhitespace?: boolean }): GitTextDiff;
  /** The user's "Trust this folder" (Source control panel): git may run here from now on. Remembered in app data. */
  trust(): boolean;
  /** "Stop trusting this folder": git stops here at once (status, marks, actions). */
  untrust(): boolean;
}
export type GitOp = keyof GitOps;
export const GIT_OPS: readonly GitOp[] = ['status', 'headFile', 'diff', 'stage', 'unstage', 'discard', 'commit', 'lastMessage', 'fetch', 'pull', 'push', 'branches', 'createBranch', 'switchBranch', 'log', 'commitFiles', 'cancel', 'diffTexts', 'remoteBranches', 'branchDetails', 'nudge', 'visibility', 'hunks', 'stageHunks', 'trust', 'untrust', 'numstat'];
