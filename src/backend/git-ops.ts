// Pure helpers for the tier-2 git operations: output parsers, error classification, terminal hand-off
// commands. No I/O (unit-tested with fixtures).
import type { GitBranchInfo, GitCommit, GitCommitFile, GitCommitInfo } from '../shared/git';

/**
 * Local branches, phase 1: refname, commit id, upstream, HEAD marker — read from the refs alone, no
 * commit objects and no `:short` atoms (those check every ref for ambiguity: seconds with 50k refs).
 */
export const LOCAL_BRANCH_FORMAT = ['%(refname)', '%(objectname)', '%(upstream)', '%(HEAD)'].join('%00');

const shortRef = (r: string) => r.replace(/^refs\/(heads|remotes)\//, '');

/** Local branches, name-sorted, the current one first. */
export function parseLocalBranches(out: string): GitBranchInfo[] {
  const list: GitBranchInfo[] = [];
  for (const line of out.split('\n')) {
    const [ref, oid, upstream, head] = line.split('\0');
    if (!ref?.startsWith('refs/heads/')) continue;
    list.push({ name: shortRef(ref), remote: false, current: head === '*', oid: oid ?? '', upstream: upstream ? shortRef(upstream) : null });
  }
  return list.sort((a, b) => Number(b.current) - Number(a.current) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `for-each-ref --format=%(refname)%00%(objectname) refs/remotes` → name-sorted remote branches (without the HEAD aliases). */
export function parseRemoteRefs(out: string): Array<{ name: string; oid: string }> {
  const list: Array<{ name: string; oid: string }> = [];
  for (const line of out.split('\n')) {
    const i = line.indexOf('\0');
    if (i < 0 || !line.startsWith('refs/remotes/') || line.slice(0, i).endsWith('/HEAD')) continue;
    list.push({ name: line.slice(13, i), oid: line.slice(i + 1) });
  }
  return list; // for-each-ref already sorts by refname
}

/** `git log --no-walk=unsorted --stdin -z --format=%H%x1f%ct%x1f%s` → date + subject per commit. */
export const DETAIL_FORMAT = ['%H', '%ct', '%s'].join('%x1f');
export function parseDetails(out: string): GitCommitInfo[] {
  const list: GitCommitInfo[] = [];
  for (const rec of out.split('\0')) {
    const [oid, date, subject] = rec.replace(/^\n+/, '').split('\x1f');
    if (/^[0-9a-f]{40,64}$/.test(oid ?? '')) list.push({ oid, date: Number(date) || 0, subject: subject ?? '' });
  }
  return list;
}

/** log format: fields separated by \x1f, commits by NUL (-z). No %D: decorations load every ref. */
export const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');

export function parseLog(out: string): GitCommit[] {
  const list: GitCommit[] = [];
  for (const rec of out.split('\0')) {
    const r = rec.replace(/^\n+/, '');
    if (!r) continue;
    const [oid, short, parents, author, email, date, subject] = r.split('\x1f');
    if (!/^[0-9a-f]{40,64}$/.test(oid ?? '')) continue;
    list.push({ oid, short, parents: parents ? parents.split(' ').filter(Boolean) : [], author: author ?? '', email: email ?? '', date: Number(date) || 0, subject: subject ?? '' });
  }
  return list;
}

const NAME_STATUS: Record<string, GitCommitFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

/** `git diff-tree -r -z --name-status -M` → files, mapped from repo paths to workspace paths. */
export function parseNameStatus(out: string, prefix = ''): GitCommitFile[] {
  const pre = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
  const ws = (p: string | undefined) => (p === undefined ? null : !pre ? p : p.startsWith(pre) ? p.slice(pre.length) : null);
  const f = out.split('\0');
  const files: GitCommitFile[] = [];
  for (let i = 0; i < f.length; i++) {
    const code = f[i];
    if (!code) continue;
    const status = NAME_STATUS[code[0]];
    if (!status) continue;
    if (status === 'renamed' || status === 'copied') {
      const from = f[++i];
      const to = ws(f[++i]);
      if (to !== null) files.push({ path: to, status, from: ws(from) });
    } else {
      const p = ws(f[++i]);
      if (p !== null) files.push({ path: p, status });
    }
  }
  return files;
}

/** Network / credential failures that a terminal (prompts allowed there) can get past. */
const AUTH =
  /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|host key verification failed|passphrase|invalid username or password|access denied|repository not found|returned error: 40[13]|logon failed|no such identity|bad credentials|requested url returned error: 403/i;

export function isAuthError(stderr: string): boolean {
  return AUTH.test(stderr);
}

/** The most useful lines of git's error output (no hint: noise, no progress lines). */
export function gitMessage(stderr: string, max = 4): string {
  const lines = stderr
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l) && !/^(remote: )?(counting|compressing|writing|enumerating|receiving|resolving|total|unpacking) /i.test(l));
  return lines.slice(0, max).join('\n');
}

/** Names safe to put into a shell command verbatim (bash, zsh, PowerShell, cmd). */
const SHELL_SAFE = /^[A-Za-z0-9._/@+-]+$/;

/** `git <args>` for a terminal, or plain `git <verb>` when an argument would need shell quoting. */
export function terminalCommand(args: string[]): string {
  return args.every((a) => SHELL_SAFE.test(a) && !a.startsWith('-') ? true : /^-[-A-Za-z]+$/.test(a)) ? `git ${args.join(' ')}` : `git ${args[0]}`;
}

// ---- trace2 counters (status → "would an index refresh help?") ------------------------------------

/** Env for git's trace2 event stream on stderr (fd 2), short records, regions two levels deep. */
export const TRACE2_ENV: Record<string, string> = { GIT_TRACE2_EVENT: '2', GIT_TRACE2_EVENT_BRIEF: '1', GIT_TRACE2_EVENT_NESTING: '2' };

/** stderr with trace2 event lines → the real messages + numeric `data` counters (`refresh/sum_scan` …). */
export function splitTrace2(text: string): { stderr: string; data: Record<string, number> } {
  if (!text.includes('{"event":')) return { stderr: text, data: {} };
  const data: Record<string, number> = {};
  const keep: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"event":')) {
      keep.push(line);
      continue;
    }
    if (!line.startsWith('{"event":"data"')) continue;
    try {
      const j = JSON.parse(line) as { key?: unknown; value?: unknown };
      if (typeof j.key === 'string' && typeof j.value === 'string' && /^\d{1,15}$/.test(j.value)) data[j.key] = Number(j.value);
    } catch {}
  }
  return { stderr: keep.join('\n'), data };
}
