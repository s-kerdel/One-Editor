// App-wide singleton state + extension points. Feature modules import `app` and plug in via:
//   registerCommand()      (./commands)       — palette + keybindings
//   app.registerPanel()                       — sidebar panels (files, search, outline, ...)
//   app.events.on(...)                        — doc/workspace lifecycle
//   app.editor / app.preview                  — controllers implemented by ../editor and ../preview
import { signal, computed, type Signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import type { BackendApi, Settings, TreeNode, WorkspaceInfo, Eol, TextEncoding } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/api';

// ---------- controller contracts (implemented by editor/ and preview/) ----------

export interface RevealTarget {
  line: number; // 0-based
  col?: number; // 0-based column within line
  length?: number; // select this many chars from col
  /** PDF viewer: 1-based page to show (`[[doc.pdf#page=3]]`). */
  page?: number;
}

export interface EditorController {
  /** Show the document for `path`, creating its state from `content` the first time. */
  open(path: string, content: string): void;
  close(path: string): void;
  /** Current text of an open doc (defaults to active). */
  getContent(path?: string): string | undefined;
  /** Replace text (external reload / formatting). Keeps undo history unless resetHistory. */
  setContent(path: string, content: string, opts?: { resetHistory?: boolean }): void;
  rename(from: string, to: string): void;
  focus(): void;
  reveal(target: RevealTarget): void;
  setViewMode(mode: Settings['viewMode']): void;
  applySettings(s: Settings): void;
  getCursor(): { line: number; col: number; selectionLength: number };
  /** Top visible line (0-based) — used for scroll sync. */
  getTopLine(): number;
  scrollToLine(line: number): void;
  onChange(cb: (path: string, content: string) => void): () => void;
  /** `edited`: the move came with a document change (typing, undo, format), not a pure cursor move. */
  onCursor(cb: (edited?: boolean) => void): () => void;
  onScroll(cb: (topLine: number) => void): () => void;

  // ---- optional capabilities (feature modules must feature-detect) ----
  /** Highlight all matches of a search in the active editor (null clears). Used by search. */
  highlightSearch?(q: { search: string; caseSensitive?: boolean; regexp?: boolean; wholeWord?: boolean } | null): void;
  /** Apply minimal edits (keeps cursor + undo granularity). Offsets are into the LF-normalised doc. Used by format. */
  applyChanges?(path: string, changes: Array<{ from: number; to: number; insert: string }>, opts?: { selection?: { anchor: number; head?: number } }): void;
  /** Character offset of the cursor in the active doc. */
  getCursorOffset?(): number;
  /** The underlying CodeMirror EditorView (escape hatch; avoid if a method above suffices). */
  getView?(): unknown;
  /** Override the syntax-highlighting language of a doc (`languages.ts` id); null = auto (by extension).
   *  For a .md file, a non-markdown language turns it into a plain code view (no live preview). */
  setLanguage?(path: string, languageId: string | null): void;
  /** Language currently used for a doc (defaults to active). `auto` = chosen by extension, not overridden. */
  getLanguage?(path?: string): { id: string; name: string; auto: boolean } | null;
  onLanguageChange?(cb: (path: string) => void): () => void;
}

export interface PreviewController {
  render(path: string, markdown: string): void;
  scrollToLine(line: number): void;
  onScroll(cb: (topLine: number) => void): () => void;
  dispose(): void;
}

export interface SidebarPanel {
  id: string;
  title: string;
  icon: string; // short text / emoji / svg markup string
  order?: number;
  component: ComponentType;
}

export interface Tab {
  path: string;
}

export interface DocState {
  path: string;
  /** Content as last loaded from / saved to disk. */
  saved: string;
  /** Live content (mirrors editor). */
  content: string;
  mtime: number;
  eol: Eol;
  dirty: Signal<boolean>;
  /** On-disk encoding details, preserved on save. */
  bom?: boolean;
  encoding?: TextEncoding;
  /** Binary/image file: shown in a viewer, never written back. */
  binary?: boolean;
  /** Viewer docs (PDF): where to go once the viewer is ready (openFile's reveal), consumed by the viewer. */
  reveal?: RevealTarget;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
  /** Optional buttons (shell renders them). */
  actions?: Array<{ label: string; run: () => void }>;
}

type Handler = (...args: any[]) => void;
class Emitter<Events extends Record<string, Handler>> {
  private map = new Map<keyof Events, Set<Handler>>();
  on<K extends keyof Events>(ev: K, fn: Events[K]): () => void {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(fn);
    return () => this.map.get(ev)?.delete(fn);
  }
  emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>) {
    this.map.get(ev)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[event ${String(ev)}]`, err);
      }
    });
  }
}

export type AppEvents = {
  'workspace:opened': (ws: WorkspaceInfo) => void;
  'tree:changed': (tree: TreeNode) => void;
  'doc:opened': (path: string) => void;
  'doc:changed': (path: string, content: string) => void;
  'doc:saved': (path: string, content: string) => void;
  'doc:closed': (path: string) => void;
  /** File created/changed/deleted on disk (external or ours). content undefined → deleted. */
  'file:updated': (path: string, content: string | undefined) => void;
  'file:renamed': (from: string, to: string) => void;
  'active:changed': (path: string | null) => void;
  'settings:changed': (s: Settings) => void;
  /** What the indexers read changed (ignore rules, size cap, excluded folders): search + knowledge rebuild. */
  'index:stale': () => void;
  /** {{variables}} data, active env / target or display setting changed (preview re-renders). */
  'variables:changed': () => void;
  /** Files changed on disk that are not open (no content: indexers re-read them, coalesced, off the UI thread). */
  'files:changed': (paths: string[]) => void;
  /** An open viewer doc (PDF) changed on disk: its viewer reloads the bytes (never read as text). */
  'binary:changed': (path: string) => void;
  /** openFile(path, reveal) on a viewer doc (PDF page), for a viewer that is already showing it. */
  'viewer:reveal': (path: string, target: RevealTarget) => void;
  /** A viewer doc (PDF) now shows this 1-based page (scrolling included) — navigation history follows it. */
  'viewer:page': (path: string, page: number) => void;
};

class App {
  backend!: BackendApi;
  editor: EditorController | null = null;
  preview: PreviewController | null = null;
  readonly events = new Emitter<AppEvents>();

  readonly workspace = signal<WorkspaceInfo | null>(null);
  readonly tree = signal<TreeNode | null>(null);
  readonly settings = signal<Settings>({ ...DEFAULT_SETTINGS });
  readonly tabs = signal<Tab[]>([]);
  readonly activePath = signal<string | null>(null);
  readonly docs = new Map<string, DocState>();
  readonly sidebarPanel = signal<string>('files');
  readonly sidebarVisible = signal(true);
  readonly panels = signal<SidebarPanel[]>([]);
  /** Modal overlay slot (command palette, quick switcher, dialogs). */
  readonly overlay = signal<ComponentType | null>(null);
  readonly toasts = signal<Toast[]>([]);
  readonly ready = signal(false);

  /** Flat list of every file path in the workspace tree. */
  readonly files = computed<string[]>(() => {
    const out: string[] = [];
    const walk = (n: TreeNode | null | undefined) => {
      if (!n) return;
      if (n.kind === 'file') out.push(n.path);
      else n.children?.forEach(walk);
    };
    walk(this.tree.value);
    return out;
  });

  registerPanel(p: SidebarPanel) {
    this.panels.value = [...this.panels.value.filter((x) => x.id !== p.id), p].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }

  toast(message: string, kind: Toast['kind'] = 'info', ms = 3500, actions?: Toast['actions']) {
    const id = Date.now() + Math.random();
    // Same message twice in a row → don't stack duplicates.
    const list = this.toasts.value.filter((t) => t.message !== message).slice(-4);
    this.toasts.value = [...list, { id, message, kind, actions }];
    setTimeout(() => this.dismissToast(id), ms);
    return id;
  }

  dismissToast(id: number) {
    this.toasts.value = this.toasts.value.filter((t) => t.id !== id);
  }

  /** Follow a [[wikilink]] target from a note (implemented by knowledge: resolves, or creates the note).
   *  Callers: `app.openLink ? app.openLink(t, from) : fallback resolveWikiTarget + openFile`. */
  openLink?: (target: string, fromPath: string, opts?: { newTab?: boolean }) => Promise<void>;

  /** Open the search panel with a query, e.g. `app.openSearch?.('tag:foo')` (implemented by search). */
  openSearch?: (query: string, opts?: { replace?: boolean; regex?: boolean }) => void;

  /** Desktop only (set by terminal/install): paste a shell code block into the active / a new terminal,
   *  without pressing Enter unless asked. Editor / preview draw "Run in terminal" when this exists. */
  runInTerminal?: (code: string, opts?: { lang?: string | null; pressEnter?: boolean }) => Promise<boolean>;

  /** Go back / forward (../nav, set once its chunk is in; feature-detect): the next move — cursor or PDF page —
   *  is a navigation and gets its own history entry, however short. File switches and jumps of more
   *  than ~10 lines are recorded without it. */
  markNavigation?: () => void;

  /** {{variables}} (../variables): render hook + copy / run with resolved values. Set by the editor chunk
   *  (actions load the variables chunk on demand); feature-detect. */
  variables?: import('../variables/api').VariablesApi;

  // Implemented in ./documents.ts (assigned at startup to avoid import cycles).
  openFile!: (path: string, reveal?: RevealTarget) => Promise<void>;
  saveFile!: (path?: string) => Promise<boolean>;
  closeTab!: (path: string) => Promise<void>;
}

export const app = new App();
// Exposed for E2E tests and debugging.
(globalThis as any).__secEdit = app;
