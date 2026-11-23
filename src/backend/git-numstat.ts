// `git diff --raw --numstat -z` → one row per changed tracked file (status + added / removed line counts).
// Pure parser for GitService.numstat (the terminal's "AI changes" list asks for it at the end of an agent's turn).
import type { GitNumstatRow } from '../shared/git';

export const NUMSTAT_MAX_ROWS = 5000;

/**
 * With `-z` the raw section comes first (`:100644 100644 <oid> <oid> M NUL path NUL`), then the numstat section
 * (`added TAB removed TAB path NUL`; `-` `-` for a binary file → 0 / 0). `--no-renames` is assumed: one path per record.
 */
export function parseNumstat(z: string, max = NUMSTAT_MAX_ROWS): GitNumstatRow[] {
  const status = new Map<string, GitNumstatRow['status']>();
  const out: GitNumstatRow[] = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length && out.length < max; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec[0] === ':') {
      const letter = rec.slice(rec.lastIndexOf(' ') + 1)[0];
      const path = parts[++i];
      if (path) status.set(path, letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified');
      continue;
    }
    const m = /^(\d{1,9}|-)\t(\d{1,9}|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    out.push({ path: m[3], additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]), status: status.get(m[3]) ?? 'modified' });
  }
  return out;
}
