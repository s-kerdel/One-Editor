// Search + link indexes of one shared folder, built in this process on the first search / link call:
// the same paged text stream the app's indexers read (Workspace.readAllTextPage: git-ignored files,
// lockfiles, minified files and files over search.maxFileSizeKB are skipped there), filtered by the
// MCP visibility rule. Kept current from the workspace watcher; freed with the folder when it goes idle.
import type { FsEvent } from '../shared/api';
import type { Workspace } from '../backend/workspace';
import { SearchEngine } from '../search/engine';
import { KnowledgeIndex } from '../knowledge/index';

const PAGE_BYTES = 4 << 20;
const REFRESH_DEBOUNCE_MS = 120;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export class FolderIndex {
  readonly engine = new SearchEngine();
  readonly knowledge = new KnowledgeIndex();
  private done = 0;
  private total = 0;
  private complete = false;
  private failed: string | null = null;
  private disposed = false;
  private readonly building: Promise<void>;
  private pending = new Set<string>();
  private gone = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly ws: Workspace,
    private readonly visible: (path: string) => boolean,
    /** A plain one-name file (no hard link to somewhere else): checked before any text is taken in. */
    private readonly single: (path: string) => Promise<boolean> = async () => true,
  ) {
    this.building = this.build();
  }

  private async build() {
    try {
      let cursor: string | null = null;
      do {
        const page = await this.ws.readAllTextPage({ cursor, maxBytes: PAGE_BYTES });
        if (this.disposed) return;
        const ok = await Promise.all(page.files.map((f) => (f.binary || !this.visible(f.path) ? false : this.single(f.path))));
        if (this.disposed) return;
        for (const [i, f] of page.files.entries()) {
          if (!ok[i]) continue;
          this.engine.upsert({ path: f.path, content: f.content, mtime: f.mtime });
          this.knowledge.update(f.path, f.content);
        }
        this.done = page.done ?? this.done + page.files.length;
        this.total = page.total ?? this.total;
        cursor = page.nextCursor;
        if (cursor) await yieldLoop();
      } while (cursor);
      // Attachments and other files resolve as link targets too.
      this.knowledge.setFiles(this.ws.filePaths().filter(this.visible));
      this.complete = true;
      this.schedule(); // events that came in while building
    } catch (err) {
      this.failed = 'the index could not be built';
      console.error('[mcp] index build failed', err);
    }
  }

  /** Waits up to `ms` for the first build. false = still building (answers are partial). */
  async ready(ms: number): Promise<boolean> {
    if (this.complete) return true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.building, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    return this.complete;
  }

  get isComplete() {
    return this.complete;
  }

  /** "ready (1,234 files)" / "building 120/400" — shown to the model when answers may be incomplete. */
  progress(): string {
    if (this.failed) return `error: ${this.failed}`;
    return this.complete ? `ready (${this.engine.size} files)` : `building ${this.done}/${this.total || '?'}`;
  }

  onEvents(events: FsEvent[]) {
    if (this.disposed) return;
    for (const e of events) {
      if (e.type === 'add' || e.type === 'change') {
        this.gone.delete(e.path);
        if (this.visible(e.path)) this.pending.add(e.path);
      } else if (e.type === 'unlink') {
        this.pending.delete(e.path);
        this.gone.add(e.path);
      } else if (e.type === 'unlinkDir') {
        const pre = `${e.path}/`;
        for (const p of this.engine.paths()) if (p.startsWith(pre)) this.gone.add(p);
        for (const p of this.knowledge.files()) if (p.startsWith(pre)) this.gone.add(p);
        for (const p of [...this.pending]) if (p.startsWith(pre)) this.pending.delete(p);
      }
    }
    this.schedule();
  }

  private schedule() {
    if (!this.complete || this.disposed || (!this.pending.size && !this.gone.size)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), REFRESH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Waits for queued updates (a search right after an edit sees it). */
  async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.flush();
    }
    await this.refreshing;
  }

  private async flush() {
    this.timer = null;
    if (this.refreshing) await this.refreshing;
    const paths = [...this.pending];
    const gone = [...this.gone];
    this.pending.clear();
    this.gone.clear();
    if (!paths.length && !gone.length) return;
    this.refreshing = (async () => {
      for (const p of gone) {
        this.engine.remove(p);
        this.knowledge.remove(p);
      }
      if (paths.length) {
        try {
          const r = await this.ws.readIndexedFiles(paths);
          if (this.disposed) return;
          const ok = await Promise.all(r.files.map((f) => (f.binary || !this.visible(f.path) ? false : this.single(f.path))));
          for (const [i, f] of r.files.entries()) {
            if (!ok[i]) {
              this.engine.remove(f.path);
              this.knowledge.remove(f.path);
              continue;
            }
            this.engine.upsert({ path: f.path, content: f.content, mtime: f.mtime });
            this.knowledge.update(f.path, f.content);
          }
          for (const p of [...r.skipped, ...r.gone]) {
            this.engine.remove(p);
            this.knowledge.remove(p);
          }
        } catch (err) {
          console.error('[mcp] index refresh failed', err);
        }
      }
      this.knowledge.setFiles(this.ws.filePaths().filter(this.visible));
    })().finally(() => (this.refreshing = null));
    await this.refreshing;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.engine.clear();
    this.knowledge.clear();
  }
}
