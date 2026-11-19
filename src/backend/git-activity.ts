// Git activity log (backend): one entry per git process (kind, trigger, duration, repo), kept in memory for
// tests / measurements and printed with SEC_EDIT_GIT_LOG=1. Status runs also reach the app's shared activity
// log in the renderer (src/renderer/app/activity.ts) through the monitor's `ran` push events.

export interface GitActivity {
  /** git subcommand ("status", "cat-file", "log", …). */
  kind: string;
  /** Why it ran ("save", "fs", "git-dir", "focus", "open", "action"…), when known. */
  trigger?: string;
  ms: number;
  /** Repository (or working) folder. */
  repo: string;
  ok: boolean;
  /** Date.now() at the end of the run. */
  at: number;
}

const RECENT = 500;
const recent: GitActivity[] = [];
const sinks = new Set<(a: GitActivity) => void>();
const verbose = !!process.env.SEC_EDIT_GIT_LOG;

export function logGitActivity(a: GitActivity) {
  recent.push(a);
  if (recent.length > RECENT) recent.splice(0, recent.length - RECENT);
  for (const s of sinks) {
    try {
      s(a);
    } catch {}
  }
  if (verbose) console.log(`[git] ${a.kind}${a.trigger ? ` (${a.trigger})` : ''} ${a.ms} ms ${a.ok ? '' : 'FAILED '}${a.repo}`);
}

export function onGitActivity(cb: (a: GitActivity) => void): () => void {
  sinks.add(cb);
  return () => sinks.delete(cb);
}

/** Entries since `since` (Date.now() value), oldest first. */
export function recentGitActivity(since = 0): GitActivity[] {
  return recent.filter((a) => a.at >= since);
}

/** The git subcommand in an argument list (skips `-c key=value` pairs and global flags). */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') i++;
    else if (!a.startsWith('-')) return a;
  }
  return '?';
}
