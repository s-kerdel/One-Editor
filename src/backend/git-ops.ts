// Pure helpers for the tier-2 git operations: output parsers, error classification, terminal hand-off
// commands. No I/O (unit-tested with fixtures).
import type { GitBranchInfo, GitCommit, GitCommitFile } from '../shared/git';

/**
 * for-each-ref format: one ref per line, fields separated by NUL (refnames cannot contain either).
 * No %(upstream:track): it walks history once per tracking branch (seconds on big repositories).
 */
export const BRANCH_FORMAT = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(upstream:short)', '%(HEAD)', '%(committerdate:unix)', '%(contents:subject)'].join('%00');

export function parseBranches(out: string): GitBranchInfo[] {
  const list: GitBranchInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, name, oid, upstream, head, date, subject] = line.split('\0');
    if (!ref || !name) continue;
    const remote = ref.startsWith('refs/remotes/');
    if (remote && ref.endsWith('/HEAD')) continue; // origin/HEAD is an alias, not a branch
    list.push({ name, remote, current: head === '*', oid: oid ?? '', upstream: upstream || null, date: Number(date) || 0, subject: subject ?? '' });
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
