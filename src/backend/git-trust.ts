// Which folders git may run in. A repository's own files decide what git executes — hooks, filter
// drivers, `core.fsmonitor`, `core.sshCommand`, an `ext::` remote — so a folder that came from someone
// else (a clone, an unpacked archive) gets NO git at all until the user says "Trust" in the Source
// control panel: no status, no marks, no diff, no actions (BackendService.git refuses before any
// GitService exists, so nothing is spawned).
//  - Remembered per folder in <app data>/git-trust.json (never settings.json or the page's storage):
//    the folder's real path (symlinks resolved), compared with the folder's own case rule.
//  - Migration: the first time this file is created, the folders in the recent list count as trusted —
//    they are the user's own, used with git before this existed. Everything opened later starts untrusted.
//  - The desktop app and a browser-mode server share the file (same app data folder).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './filelock';

interface TrustFile {
  version: 1;
  /** Real paths the user trusted. */
  trusted: string[];
  /** Recent folders at migration, as they were spelled (not resolved: a sleeping WSL distro or a network share must not be woken at launch). */
  legacy: string[];
}

export interface GitTrustDeps {
  /** The recent-folder list, read once when the trust file does not exist yet. */
  recent: () => Promise<string[]>;
  realpath?: (abs: string) => Promise<string>;
}

const MAX_TRUSTED = 2000;

export class GitTrust {
  private migrating: Promise<void> | null = null;

  constructor(
    private readonly file: string,
    private readonly deps: GitTrustDeps,
  ) {}

  private async read(): Promise<TrustFile | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch (err: any) {
      // Missing = never created (→ migration). Unreadable / corrupt = nothing is trusted (never "everything").
      return err?.code === 'ENOENT' ? null : { version: 1, trusted: [], legacy: [] };
    }
    const o = (raw && typeof raw === 'object' ? raw : {}) as { trusted?: unknown; legacy?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
    return { version: 1, trusted: list(o.trusted), legacy: list(o.legacy) };
  }

  private async write(f: TrustFile) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(f, null, 2));
    await fsp.rename(tmp, this.file).catch(async (err) => {
      await fsp.rm(tmp, { force: true });
      throw err;
    });
  }

  /**
   * Creates the file from the recent folders if it does not exist. Call BEFORE a folder is added to the
   * recent list (BackendService.openWorkspace does), or a folder opened for the first time would migrate itself in.
   */
  ready(): Promise<void> {
    return (this.migrating ??= (async () => {
      if (await this.read()) return;
      const recent = (await this.deps.recent().catch(() => [])).filter((p) => typeof p === 'string' && p).map((p) => path.resolve(p));
      await withFileLock(this.file, async () => {
        if (!(await this.read())) await this.write({ version: 1, trusted: [], legacy: [...new Set(recent)] });
      });
    })().catch(() => {
      this.migrating = null; // could not write (read-only profile): nothing is trusted, try again later
    }));
  }

  private real(root: string): Promise<string> {
    const abs = path.resolve(root);
    return (this.deps.realpath ?? ((p) => fsp.realpath(p)))(abs).catch(() => abs);
  }

  /** `foldCase`: this folder's own rule (Workspace.foldsCase), never the platform's. */
  async isTrusted(root: string, foldCase: boolean): Promise<boolean> {
    await this.ready();
    const f = await this.read();
    if (!f) return false;
    const eq = (a: string, b: string) => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
    const real = await this.real(root);
    if (f.trusted.some((t) => eq(t, real))) return true;
    const abs = path.resolve(root);
    return f.legacy.some((t) => eq(t, abs) || eq(t, real));
  }

  async set(root: string, foldCase: boolean, trusted: boolean): Promise<void> {
    await this.ready();
    const real = await this.real(root);
    const abs = path.resolve(root);
    const eq = (a: string, b: string) => (foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
    await withFileLock(this.file, async () => {
      const f = (await this.read()) ?? { version: 1 as const, trusted: [], legacy: [] };
      const not = (t: string) => !eq(t, real) && !eq(t, abs);
      f.trusted = f.trusted.filter(not);
      f.legacy = f.legacy.filter(not);
      if (trusted) f.trusted = [...f.trusted, real].slice(-MAX_TRUSTED);
      await this.write(f);
    });
  }
}
