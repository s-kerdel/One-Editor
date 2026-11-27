// Which folders the window may open. The renderer asks (`rpc:openWorkspace`), but a page that was taken
// over (XSS in a note) must not be able to turn "an editor for this folder" into "read and write any
// folder of this user". So main only opens what it has seen for itself:
//  - the native folder dialog's answer, launch arguments / a second instance's arguments,
//  - a file or folder dropped on the window (its path is read from the File object by the preload and
//    reported from there — page script cannot make one up),
//  - the recent folders (recent.json in user data; only successful opens get in),
//  - folders inside the open folder ("Open as project"),
//  - the folder of a vouched FILE (a lone file is opened in its folder).
// A path from the page is decided on its spelling first: only main's own paths go to the disk (a UNC path would
// connect to its host and leak the user's NTLM hash), and the page's only when it is spelled inside the open folder.
// No electron import: unit-tested with a fake file system.
type PlatformPath = typeof import('node:path').posix;
import { isInsideDir } from '../backend/pathsafe';

export interface OpenGateDeps {
  p: PlatformPath;
  /** Fold case when comparing (the platform's usual answer; a wrong "equal" only ever matches a vouched spelling). */
  foldCase: boolean;
  /** Symlink-free path, or null when it does not exist. */
  realpath(abs: string): Promise<string | null>;
  isFile(abs: string): Promise<boolean>;
  recent(): Promise<string[]>;
  root(): string | null;
}

const MAX_VOUCHED = 512;

export class OpenGate {
  /** Comparison key → the path as it was seen (a case-sensitive folder on a folding platform — WSL — needs the real spelling). Insertion order = age. */
  private vouched = new Map<string, string>();

  constructor(private readonly d: OpenGateDeps) {}

  private key(abs: string): string {
    const r = this.d.p.resolve(abs);
    return this.d.foldCase ? r.toLowerCase() : r;
  }

  /** Main saw this path itself (dialog, argv, drop). */
  vouch(abs: unknown): void {
    if (typeof abs !== 'string' || !abs || abs.includes('\0') || !this.d.p.isAbsolute(abs)) return;
    const k = this.key(abs);
    this.vouched.delete(k);
    this.vouched.set(k, this.d.p.resolve(abs));
    if (this.vouched.size > MAX_VOUCHED) this.vouched.delete(this.vouched.keys().next().value as string);
  }

  /** Main saw exactly this path (as written, the platform's case rule): sync, no disk access. For a lookup that must
   *  never touch a path main did not see itself (resolvePath on a UNC path: ServiceHooks.remotePathOk). */
  seen(abs: unknown): boolean {
    return this.pagePath(abs) && this.vouched.has(this.key(abs));
  }

  /**
   * Comparison keys of a path MAIN saw (vouched, recent, the open folder): as seen and without symlinks. Only such
   * paths go to the disk; a path from the page is compared by its spelling first (see allows / vouchedFile).
   */
  private async known(abs: string): Promise<string[]> {
    const real = await this.d.realpath(abs).catch(() => null);
    return real ? [...new Set([this.key(abs), this.key(real)])] : [this.key(abs)];
  }

  /** A path string from the page: absolute, no NUL. */
  private pagePath(abs: unknown): abs is string {
    return typeof abs === 'string' && !!abs && !abs.includes('\0') && this.d.p.isAbsolute(abs);
  }

  /**
   * This very file was seen by main (dialog, OS open, argv, drop) — not its folder, not a recent: what an outside file needs.
   * Decided on the string: the page's path itself never reaches the disk (a `\\host\share` path would connect to that
   * host and hand it the user's NTLM hash). Its real spelling (what resolvePath answered) matches a vouched file's.
   */
  async vouchedFile(abs: unknown): Promise<boolean> {
    if (!this.pagePath(abs)) return false;
    const want = this.key(abs);
    if (this.vouched.has(want)) return true;
    for (const v of this.vouched.values()) if ((await this.known(v)).includes(want)) return true;
    return false;
  }

  /**
   * May the page open this folder? String first, like vouchedFile: main's own paths (and their real spellings) are
   * compared without touching the page's path; that path goes to the disk only when it is spelled inside the open
   * folder, and is then judged by where it really is. Anything else (a UNC path main never saw included) is refused
   * without a disk access.
   */
  async allows(abs: unknown): Promise<boolean> {
    if (!this.pagePath(abs)) return false;
    const { p } = this.d;
    const want = this.key(abs);
    if (this.vouched.has(want)) return true; // the usual case: no disk access at all
    const recents = (await this.d.recent().catch(() => [])).filter((r): r is string => typeof r === 'string' && !!r && p.isAbsolute(r));
    if (recents.some((r) => this.key(r) === want)) return true;
    for (const v of [...this.vouched.values()].reverse().slice(0, 64)) {
      if ((await this.known(v)).includes(want)) return true;
      // A vouched file: its folder (never the parent of a vouched folder).
      if ((await this.known(p.dirname(v))).includes(want) && (await this.d.isFile(v).catch(() => false))) return true;
    }
    for (const r of recents) if ((await this.known(r)).includes(want)) return true;
    // Inside the open folder — judged on the real paths: a link in the folder pointing elsewhere is elsewhere.
    const root = this.d.root();
    if (root) {
      const realRoot = await this.d.realpath(root).catch(() => null);
      const lexical = p.resolve(abs);
      const spelledInside = [root, realRoot].some((dir) => !!dir && isInsideDir(lexical, dir, p, this.d.foldCase));
      if (realRoot && spelledInside) {
        const real = await this.d.realpath(lexical).catch(() => null);
        if (real && isInsideDir(real, realRoot, p, this.d.foldCase)) return true;
      }
    }
    return false;
  }
}
