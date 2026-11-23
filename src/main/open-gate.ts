// Which folders the window may open. The renderer asks (`rpc:openWorkspace`), but a page that was taken
// over (XSS in a note) must not be able to turn "an editor for this folder" into "read and write any
// folder of this user". So main only opens what it has seen for itself:
//  - the native folder dialog's answer, launch arguments / a second instance's arguments,
//  - a file or folder dropped on the window (its path is read from the File object by the preload and
//    reported from there — page script cannot make one up),
//  - the recent folders (recent.json in user data; only successful opens get in),
//  - folders inside the open folder ("Open as project"),
//  - the folder of a vouched FILE (a lone file is opened in its folder).
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

  /** Both spellings of a path: as given and without symlinks (the renderer sends back what resolvePath answered). */
  private async forms(abs: string): Promise<string[]> {
    const real = await this.d.realpath(abs).catch(() => null);
    return real ? [...new Set([this.key(abs), this.key(real)])] : [this.key(abs)];
  }

  /** This very file was seen by main (dialog, OS open, argv, drop) — not its folder, not a recent: what an outside file needs. */
  async vouchedFile(abs: unknown): Promise<boolean> {
    if (typeof abs !== 'string' || !abs || abs.includes('\0') || !this.d.p.isAbsolute(abs)) return false;
    const mine = await this.forms(this.d.p.resolve(abs));
    for (const [k, v] of this.vouched) {
      if (mine.includes(k)) return true;
      if ((await this.forms(v)).some((f) => mine.includes(f))) return true;
    }
    return false;
  }

  async allows(abs: unknown): Promise<boolean> {
    if (typeof abs !== 'string' || !abs || abs.includes('\0')) return false;
    const { p } = this.d;
    const mine = await this.forms(p.resolve(abs));
    const same = async (other: string) => (await this.forms(other)).some((f) => mine.includes(f));
    for (const k of this.vouched.keys()) if (mine.includes(k)) return true; // the usual case: no further disk access
    for (const [, v] of [...this.vouched].reverse().slice(0, 64)) {
      if (await same(v)) return true;
      // A vouched file: its folder (never the parent of a vouched folder).
      if ((await same(p.dirname(v))) && (await this.d.isFile(v).catch(() => false))) return true;
    }
    for (const r of await this.d.recent().catch(() => [])) if (typeof r === 'string' && (await same(r))) return true;
    // Inside the open folder — judged on the real paths: a link in the folder pointing elsewhere is elsewhere.
    const root = this.d.root();
    if (root) {
      const [realRoot, real] = await Promise.all([this.d.realpath(root).catch(() => null), this.d.realpath(p.resolve(abs)).catch(() => null)]);
      if (realRoot && real && isInsideDir(real, realRoot, p, this.d.foldCase)) return true;
    }
    return false;
  }
}
