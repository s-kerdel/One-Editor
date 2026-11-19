// Typed access to the backend's single `git(op, …args)` RPC (validated there).
import type { GitOp, GitOps } from '@shared/git';
import { app } from '../app/app';

export type GitCall = <K extends GitOp>(op: K, ...args: Parameters<GitOps[K]>) => Promise<ReturnType<GitOps[K]>>;

/** null when the backend has no git support. */
export function gitCall(): GitCall | null {
  const fn = app.backend?.git;
  return fn ? (fn.bind(app.backend) as GitCall) : null;
}

/** Like gitCall() but throws when git is unavailable (UI that only exists with git). */
export const git: GitCall = (op, ...args) => {
  const call = gitCall();
  if (!call) return Promise.reject(new Error('git is not available'));
  return call(op, ...args);
};
