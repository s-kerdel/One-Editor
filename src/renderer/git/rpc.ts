// Typed access to the backend's single `git(op, …args)` RPC (validated there).
// Background lists and user actions are timed into the shared activity log (status runs are logged
// from the backend's push events in index.ts). Lazy modules only: activity.ts is not in the startup chunk.
import type { GitOp, GitOps } from '@shared/git';
import { app } from '../app/app';
import { logActivity } from '../app/activity';

export type GitCall = <K extends GitOp>(op: K, ...args: Parameters<GitOps[K]>) => Promise<ReturnType<GitOps[K]>>;

const BACKGROUND: Partial<Record<GitOp, string>> = { branches: 'branches', remoteBranches: 'remote branches', branchDetails: 'branch dates', log: 'history', commitFiles: 'commit files' };
const ACTIONS = new Set<GitOp>(['stage', 'unstage', 'stageHunks', 'discard', 'commit', 'fetch', 'pull', 'push', 'switchBranch', 'createBranch']);

function outcome(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const o = r as { ok?: unknown; error?: unknown };
  if (typeof o.error === 'string') return ` · ${o.error}`; // failed / timeout / cancelled
  return o.ok === false ? ' · failed' : '';
}

function timed(call: GitCall): GitCall {
  return ((op: GitOp, ...args: unknown[]) => {
    const label = BACKGROUND[op] ?? (ACTIONS.has(op) ? op : null);
    const run = (call as (op: GitOp, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    if (!label) return run;
    const trigger = BACKGROUND[op] ? 'background' : 'action';
    const t0 = performance.now();
    const log = (tail: string) => logActivity({ kind: 'git', trigger, ms: performance.now() - t0, detail: label + tail });
    return run.then(
      (r) => (log(outcome(r)), r),
      (err) => {
        log(' · failed');
        throw err;
      },
    );
  }) as GitCall;
}

/** null when the backend has no git support. */
export function gitCall(): GitCall | null {
  const fn = app.backend?.git;
  return fn ? timed(fn.bind(app.backend) as GitCall) : null;
}

/** Like gitCall() but throws when git is unavailable (UI that only exists with git). */
export const git: GitCall = (op, ...args) => {
  const call = gitCall();
  if (!call) return Promise.reject(new Error('git is not available'));
  return call(op, ...args);
};
