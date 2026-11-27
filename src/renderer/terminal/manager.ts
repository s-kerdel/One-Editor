// Terminal sessions in the renderer: spawn / route output / resize / rename / close, and
// "Run in terminal". Knows nothing about xterm.js (views come from `createView`), so it is unit-tested
// with a fake backend and fake views.
import { signal, type Signal } from '@preact/signals';
import type { ClaudeInfo, ShellInfo, ShellList, TerminalSpawnResult } from '@shared/terminal';
import type { TerminalBackend } from './backend';
import { resolveLinkPath } from './links';
import { prepareRunText } from './run';
import { oneLine } from './claude';
import { followsAgent, type TerminalSettings } from './settings';
import type { TermTheme } from './theme';
import type { CreateView, LinkTarget, Off, TerminalView } from './types';

export interface CreateOptions {
  shellId?: string;
  cwd?: string;
  focus?: boolean;
  preset?: 'claude' | 'opencode';
  /** Timing marks (command time, panel painted). */
  t0?: number;
  panel?: number;
}

export interface ManagerDeps {
  backend: TerminalBackend;
  createView: CreateView;
  os: string;
  settings: () => TerminalSettings;
  /** Absolute workspace root (native separators), null when no folder is open. */
  workspaceRoot: () => string | null;
  /** Workspace-relative paths of every file (path links only light up for real files). */
  files: () => ReadonlySet<string>;
  /** 0-based line/col like app.openFile's RevealTarget. */
  openFile(path: string, at?: { line: number; col?: number }): void;
  openUrl(url: string): void;
  toast(message: string, kind?: 'info' | 'error' | 'success'): void;
  confirm(title: string, message: string, ok: string): Promise<boolean>;
  fontFamily(): string;
  theme(): TermTheme | null;
  /** Mod+F inside a terminal. */
  onFind?(): void;
  /** The last terminal closed (the panel hides). */
  onEmpty?(): void;
}

export type SessionStatus = 'running' | 'exited';

/** performance.now() marks of one terminal start (diagnostics + the perf E2E). */
export interface TerminalTiming {
  /** Command / click. */
  t0: number;
  /** Panel painted (Ctrl+` / launcher path). */
  panel?: number;
  /** xterm view created (chunk loaded) and mounted. */
  view?: number;
  /** PTY spawn reply from main. */
  spawned?: number;
  /** Session registered: keystrokes reach the shell. */
  ready?: number;
  firstOutput?: number;
  /** Last chunk of the start-up burst (prompt printed, output then quiet). */
  prompt?: number;
  shell?: string;
  /** Taken from the pre-warmed spare. */
  prewarmed?: boolean;
}

export interface Session {
  readonly id: number;
  /** Shell process id (diagnostics / tests). */
  readonly pid: number;
  readonly shell: ShellInfo;
  readonly cwd: string;
  readonly title: Signal<string>;
  readonly status: Signal<SessionStatus>;
  readonly exitCode: Signal<number | null>;
  readonly view: TerminalView;
  renamed: boolean;
  /** Last output time + whether any came yet (Run in terminal waits for the first prompt). */
  lastOutput: number;
  outputSeen: boolean;
  timing?: TerminalTiming;
}

const MAX_EARLY = 1 << 20; // output that beats the session registration (kept until it registers)
const MAX_EARLY_IDS = 32; // …for this many terminals at most (a late "exit" for a closed one never piles up)
/** `.se-term-view` inset (terminal.css): horizontal / vertical px the view does not get of the host. */
const VIEW_INSET = { x: 18, y: 8 };

/** OSC titles are shell-controlled: no control characters, bounded, and no bare exe paths. */
export function cleanTitle(raw: string, shell: ShellInfo): string | null {
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 60);
  if (!t) return null;
  if (/\.exe$/i.test(t) && /[\\/]/.test(t)) return null; // "C:\Program Files\PowerShell\7\pwsh.exe"
  return t === shell.path ? null : t;
}

/** "PowerShell 7", then "PowerShell 7 (2)", "(3)"… for more terminals of the same profile. */
export function nextTitle(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`;
}

export class TerminalManager {
  readonly sessions = signal<Session[]>([]);
  readonly activeId = signal<number | null>(null);
  readonly shells = signal<ShellList | null>(null);
  /** Last failure to start a terminal (shown in the panel's empty state). */
  readonly error = signal<string | null>(null);
  readonly starting = signal(false);
  /** Last terminal starts (most recent last, max 50). */
  readonly timings: TerminalTiming[] = [];

  private readonly d: ManagerDeps;
  private readonly early = new Map<number, string[]>();
  private readonly promptTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly hostWaiters: Array<() => void> = [];
  private spare: { session: Session; key: string } | null = null;
  private spareStarting = false;
  private disposed = false;
  private readonly offs: Off[] = [];
  private host: HTMLElement | null = null;
  private shellsP: Promise<ShellList | null> | null = null;
  private shellsFor = ''; // default-shell setting the cached list was made for
  private claudeP: Promise<ClaudeInfo | null> | null = null;
  private claudeFor = '';
  /** Cell size the last view measured (font size it was measured at). */
  private cell: { w: number; h: number; font: number } | null = null;
  private readonly earlyExit = new Map<number, number>();
  /** Recently closed ids: their late output / exit is dropped, not buffered as "early". */
  private readonly closed = new Set<number>();

  constructor(d: ManagerDeps) {
    this.d = d;
    this.offs.push(
      d.backend.onData((e) => this.onData(e.id, e.data)),
      d.backend.onExit((e) => this.onExit(e.id, e.exitCode)),
    );
  }

  get active(): Session | null {
    return this.sessions.value.find((s) => s.id === this.activeId.value) ?? null;
  }

  byId(id: number): Session | undefined {
    return this.sessions.value.find((s) => s.id === id);
  }

  /** A visible session or the hidden spare (output / exit routing). */
  private find(id: number): Session | undefined {
    return this.byId(id) ?? (this.spare?.session.id === id ? this.spare.session : undefined);
  }

  /** Internal bookkeeping sizes (leak checks in tests / diagnostics). */
  stats() {
    return { sessions: this.sessions.value.length, spare: this.spare ? 1 : 0, early: this.early.size, earlyExit: this.earlyExit.size, promptTimers: this.promptTimers.size, hostWaiters: this.hostWaiters.length, timings: this.timings.length };
  }

  /** The hidden pre-warmed session, if any (tests / diagnostics). */
  get spareSession(): Session | null {
    return this.spare?.session ?? null;
  }

  /** The panel's terminal area: the active view lives in here (imperatively; xterm owns its DOM). */
  setHost(el: HTMLElement | null) {
    this.host = el;
    this.mountActive();
    if (el) for (const w of this.hostWaiters.splice(0)) w();
  }

  /** Resolves once the panel has handed over its host (the panel renders a moment after it opens). */
  whenHost(maxMs = 200): Promise<void> {
    if (this.host) return Promise.resolve();
    return new Promise((resolve) => {
      this.hostWaiters.push(resolve);
      setTimeout(resolve, maxMs);
    });
  }

  async loadShells(refresh = false): Promise<ShellList | null> {
    if (!this.d.backend.available) return null;
    const prefer = this.d.settings().defaultShell;
    if (refresh || !this.shellsP || prefer !== this.shellsFor) {
      this.shellsFor = prefer;
      this.shellsP = this.d.backend.listShells(refresh, prefer || undefined).then(
        // Keep the Claude / Opencode info a deeper lookup added (ensureClaude), unless this is a refresh.
        (l) => (this.shells.value = { ...l, claude: l.claude ?? (refresh ? undefined : this.shells.value?.claude), opencode: l.opencode ?? (refresh ? undefined : this.shells.value?.opencode) }),
        (err) => {
          this.shellsP = null;
          this.error.value = String((err as Error)?.message ?? err);
          return null;
        },
      );
    }
    return this.shellsP;
  }

  /**
   * Is Claude Code installed? Asked only when something shows or uses it (launcher, tiles, Ask Claude):
   * with a WSL default shell the lookup starts that distro — never on the plain "new terminal" path.
   */
  ensureClaude(refresh = false): Promise<ClaudeInfo | null> {
    if (!this.d.backend.available) return Promise.resolve(null);
    const prefer = this.d.settings().defaultShell;
    if (refresh || !this.claudeP || prefer !== this.claudeFor) {
      this.claudeFor = prefer;
      this.claudeP = this.d.backend.listShells(refresh, prefer || undefined, true).then(
        (l) => ((this.shells.value = l), l.claude ?? null),
        () => ((this.claudeP = null), null),
      );
    }
    return this.claudeP;
  }

  /** PTY size before the view exists: the panel's host box ÷ the last measured cell (≈ font metrics the first time). */
  estimateSize(fontSize: number): { cols: number; rows: number } {
    const h = this.host;
    if (!h || !h.clientWidth || !h.clientHeight) return { cols: 80, rows: 24 };
    const cw = this.cell?.font === fontSize ? this.cell.w : fontSize * 0.6;
    const ch = this.cell?.font === fontSize ? this.cell.h : Math.ceil(fontSize * 1.15);
    return { cols: Math.max(2, Math.floor((h.clientWidth - VIEW_INSET.x) / cw)), rows: Math.max(1, Math.floor((h.clientHeight - VIEW_INSET.y) / ch)) };
  }

  /** The user's `terminal.defaultShell` when this machine has it, else the backend's automatic pick. */
  defaultShellId(list: ShellList | null = this.shells.value): string | null {
    if (!list) return null;
    const want = this.d.settings().defaultShell;
    return want && list.shells.some((s) => s.id === want) ? want : list.defaultId;
  }

  /** New terminal; `preset: 'claude'` starts Claude Code (in the default shell's environment) instead of a shell. */
  async create(o: CreateOptions = {}): Promise<Session | null> {
    const T: TerminalTiming = { t0: o.t0 ?? performance.now(), panel: o.panel };
    const b = this.d.backend;
    if (!b.available) return null;
    if (!this.d.workspaceRoot()) {
      this.error.value = 'Open a folder to use the terminal.';
      return null;
    }
    const adopted = this.adoptSpare(o, T);
    if (adopted) return adopted;
    this.starting.value = true;
    try {
      void this.loadShells(); // names for the launcher; spawning does not wait for the list
      const session = await this.start(o, T, true, (x) => {
        x.title.value = nextTitle(x.shell.name, this.sessions.value.map((y) => y.title.value));
        this.sessions.value = [...this.sessions.value, x];
      });
      T.ready = performance.now();
      this.record(T);
      this.error.value = null;
      if (this.byId(session.id)) this.activate(session.id, o.focus ?? true);
      this.scheduleSpare();
      return session;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.error.value = msg;
      this.d.toast(`Terminal: ${msg}`, 'error');
      return null;
    } finally {
      this.starting.value = false;
    }
  }

  /**
   * Spawn a PTY and build its view, in parallel: the shell starts while xterm.js loads / builds its DOM;
   * its first output waits in `early` until `place` made the session findable. `visible`: mount it in the
   * panel now (else it is the hidden pre-warmed spare). Throws — and kills the PTY — on failure.
   */
  private async start(o: CreateOptions, T: TerminalTiming, visible: boolean, place: (s: Session) => void): Promise<Session> {
    const b = this.d.backend;
    let view: TerminalView | null = null;
    let placed = false;
    let spawnP: Promise<TerminalSpawnResult> | null = null;
    try {
      const s = this.d.settings();
      let cwd = o.cwd ?? '';
      const size = this.estimateSize(s.fontSize);
      // `prefer` also for the Claude preset: Claude runs where the ★ default shell is (WSL or native).
      // `follow`: each agent has its own setting; off = the agent starts as in any terminal (no hooks, no server).
      spawnP = b.spawn({ shellId: o.shellId, prefer: o.shellId ? undefined : s.defaultShell || undefined, cwd: o.cwd, cols: size.cols, rows: size.rows, ...(o.preset ? { preset: o.preset, ...(followsAgent(s, o.preset) ? { follow: true } : {}) } : {}) });
      spawnP.catch(() => {}); // handled below (an unhandled rejection while the view loads would be noise)
      view = await this.d.createView({
        os: this.d.os,
        windowsBuild: this.shells.value?.windowsBuild,
        fontSize: s.fontSize,
        fontFamily: this.d.fontFamily(),
        scrollback: s.scrollback,
        gpu: s.gpu,
        theme: this.d.theme(),
        openUrl: (url) => this.d.openUrl(url),
        resolvePath: (raw) => {
          const root = this.d.workspaceRoot();
          return root ? resolveLinkPath(raw, { root, os: this.d.os, files: this.d.files(), cwd }) : null;
        },
        openPath: (t) => this.openPath(t),
        onFind: () => this.d.onFind?.(),
        onClipboardError: (what) => this.d.toast(what === 'copy' ? 'Could not copy to the clipboard' : 'The clipboard could not be read. Try Ctrl+Shift+V', 'error'),
      });
      if (visible) {
        this.mount(view);
        const cell = view.cellSize?.();
        if (cell) this.cell = { w: cell.width, h: cell.height, font: s.fontSize };
      } else view.setSize?.(size.cols, size.rows); // hidden: xterm and PTY agree until it is shown and fitted
      T.view = performance.now();
      const r = await spawnP;
      if (r.notice) this.d.toast(r.notice, 'info');
      cwd = r.cwd;
      T.spawned = performance.now();
      T.shell = r.shell.id;
      const v = view;
      if (r.windowsBuild && r.windowsBuild !== this.shells.value?.windowsBuild) v.setOptions({ windowsBuild: r.windowsBuild });
      const session: Session = {
        id: r.id,
        pid: r.pid,
        shell: r.shell,
        cwd: r.cwd,
        title: signal(r.shell.name),
        status: signal<SessionStatus>('running'),
        exitCode: signal<number | null>(null),
        view: v,
        renamed: false,
        lastOutput: 0,
        outputSeen: false,
        timing: T,
      };
      v.onInput((data) => {
        if (session.status.value === 'running') b.write(session.id, data);
        else void this.close(session.id); // "press any key to close" after a failed exit
      });
      v.onResize(({ cols, rows }) => session.status.value === 'running' && b.resize(session.id, cols, rows));
      v.onTitle((t) => {
        const title = !session.renamed && cleanTitle(t, session.shell);
        if (title) session.title.value = title;
      });
      place(session);
      placed = true;
      view = null; // owned by the session now
      // Spawned at the estimated size: give the PTY the real one (the shell redraws its prompt).
      if (visible && (v.cols !== size.cols || v.rows !== size.rows)) b.resize(session.id, v.cols, v.rows);
      for (const chunk of this.early.get(session.id) ?? []) this.onData(session.id, chunk);
      this.early.delete(session.id);
      const code = this.earlyExit.get(session.id);
      this.earlyExit.delete(session.id);
      if (code !== undefined) this.onExit(session.id, code); // it ended before it was even shown
      return session;
    } catch (err) {
      if (!placed) spawnP?.then((r) => void b.kill(r.id).catch(() => {}), () => {}); // no orphan shell
      throw err;
    } finally {
      if (view) {
        view.dispose();
        if (visible) this.mountActive(); // the failed view had replaced the active one in the panel
      }
    }
  }

  private record(T: TerminalTiming) {
    this.timings.push(T);
    if (this.timings.length > 50) this.timings.shift();
  }

  // ---- pre-warmed spare (setting terminal.prewarm, default off)

  /** Which spare fits: the default profile in the current folder. */
  private spareKey() {
    return `${this.d.settings().defaultShell}|${this.d.workspaceRoot() ?? ''}`;
  }

  /** A plain "new terminal" takes the spare (shell already started, prompt already printed). */
  private adoptSpare(o: CreateOptions, T: TerminalTiming): Session | null {
    const sp = this.spare;
    if (!sp || o.shellId || o.preset || o.cwd) return null;
    if (sp.key !== this.spareKey() || sp.session.status.value !== 'running') {
      this.dropSpare();
      return null;
    }
    this.spare = null;
    const s = sp.session;
    const now = performance.now();
    s.timing = Object.assign(T, { view: now, spawned: now, ready: now, firstOutput: now, prompt: now, shell: s.shell.id, prewarmed: true });
    s.title.value = nextTitle(s.shell.name, this.sessions.value.map((y) => y.title.value));
    this.sessions.value = [...this.sessions.value, s];
    this.record(T);
    this.error.value = null;
    this.activate(s.id, o.focus ?? true); // mounts: xterm opens, fits, and the PTY gets the real size
    this.scheduleSpare();
    return s;
  }

  /** After a terminal was opened (and the user wants it): start the next one hidden, a moment later. */
  private scheduleSpare(delay = 400) {
    if (!this.d.settings().prewarm || this.spare || this.spareStarting || !this.d.backend.available || !this.d.workspaceRoot()) return;
    this.spareStarting = true;
    const key = this.spareKey();
    setTimeout(() => {
      if (this.disposed || !this.d.settings().prewarm || key !== this.spareKey()) return void (this.spareStarting = false);
      void this.start({}, { t0: performance.now() }, false, (x) => (this.spare = { session: x, key }))
        .catch(() => {}) // a spare that fails to start is not worth a message
        .finally(() => (this.spareStarting = false));
    }, delay);
  }

  private markClosed(id: number) {
    this.closed.add(id);
    this.early.delete(id);
    if (this.closed.size > 64) this.closed.delete(this.closed.values().next().value!);
  }

  /** Kill the spare (setting off, default shell or folder changed, panel torn down). */
  dropSpare() {
    const sp = this.spare;
    if (!sp) return;
    this.spare = null;
    sp.session.view.dispose();
    this.markClosed(sp.session.id);
    if (sp.session.status.value === 'running') void this.d.backend.kill(sp.session.id).catch(() => {});
  }

  activate(id: number, focus = true) {
    if (!this.byId(id)) return;
    this.activeId.value = id;
    this.mountActive();
    if (focus) this.active?.view.focus();
  }

  /** Next / previous tab (wraps). */
  cycle(step: 1 | -1) {
    const list = this.sessions.value;
    if (list.length < 2) return;
    const i = list.findIndex((s) => s.id === this.activeId.value);
    this.activate(list[(i + step + list.length) % list.length].id);
  }

  rename(id: number, title: string) {
    const s = this.byId(id);
    const t = title.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    if (!s) return;
    s.renamed = !!t;
    s.title.value = t || s.shell.name;
  }

  /** Same profile, same folder, same tab position — a fresh process. */
  async restart(id: number): Promise<Session | null> {
    const s = this.byId(id);
    if (!s) return null;
    const at = this.sessions.value.indexOf(s);
    const preset = s.shell.kind === 'claude' || s.shell.kind === 'opencode' ? s.shell.kind : undefined;
    await this.close(id, { quiet: true });
    const n = await this.create({ shellId: preset ? undefined : s.shell.id, preset, cwd: s.cwd || undefined });
    if (n) {
      const rest = this.sessions.value.filter((x) => x !== n);
      this.sessions.value = [...rest.slice(0, at), n, ...rest.slice(at)];
    } else if (!this.sessions.value.length) this.d.onEmpty?.();
    return n;
  }

  /** Kill the shell (if still running) and drop the tab. `quiet`: no "empty" signal (restart). */
  async close(id: number, o: { quiet?: boolean } = {}): Promise<void> {
    const s = this.byId(id);
    if (!s) return;
    const list = this.sessions.value;
    const i = list.indexOf(s);
    this.sessions.value = list.filter((x) => x !== s);
    if (this.activeId.value === id) {
      const next = this.sessions.value[Math.min(i, this.sessions.value.length - 1)];
      this.activeId.value = next?.id ?? null;
      this.mountActive();
      if (next) next.view.focus();
    }
    s.view.dispose();
    this.markClosed(id);
    if (!this.sessions.value.length && !o.quiet) this.d.onEmpty?.();
    if (s.status.value === 'running') await this.d.backend.kill(id).catch(() => {});
  }

  /** Folder switch / app teardown: every shell goes (the spare too). */
  async closeAll(): Promise<void> {
    this.dropSpare();
    await Promise.all(this.sessions.value.map((s) => this.close(s.id)));
  }

  /**
   * Paste a command into the active terminal (or a new one), by default WITHOUT pressing Enter.
   * Multi-line text in a shell without bracketed paste (cmd.exe) would run line by line: ask first.
   */
  async run(code: string, o: { lang?: string | null; pressEnter?: boolean } = {}): Promise<boolean> {
    const text = prepareRunText(code, o.lang);
    if (!text || !this.d.backend.available) return false;
    let s = this.active?.status.value === 'running' ? this.active : null;
    if (!s) {
      s = await this.create({ focus: false });
      if (!s) return false;
      await this.whenReady(s);
    }
    if (text.includes('\n') && !s.view.bracketedPaste) {
      const n = text.split('\n').length;
      const ok = await this.d.confirm('Paste several lines?', `This shell runs each line as soon as it is pasted (${n} lines).`, 'Paste');
      if (!ok) return false;
    }
    this.activate(s.id, true);
    s.view.paste(text);
    if (o.pressEnter ?? this.d.settings().runPressesEnter) this.d.backend.write(s.id, '\r');
    return true;
  }

  /** The most recent running Claude Code terminal. */
  claudeSession(): Session | null {
    return [...this.sessions.value].reverse().find((s) => s.shell.kind === 'claude' && s.status.value === 'running') ?? null;
  }

  /**
   * Type `prompt` into Claude Code — reusing its terminal, else starting one — and NEVER press Enter:
   * the user reviews it first. Without bracketed paste the prompt becomes one line (a newline would submit).
   */
  async askClaude(prompt: string): Promise<boolean> {
    if (!this.d.backend.available || !prompt.trim()) return false;
    let s = this.claudeSession();
    if (!s) {
      const claude = await this.ensureClaude();
      if (claude && !claude.available) {
        this.d.toast(claude.hint ?? 'Claude Code is not installed', 'info');
        return false;
      }
      s = await this.create({ preset: 'claude', focus: false });
      if (!s) return false;
      await this.whenReady(s, 700, 12000); // the TUI draws for a while before it reads input
      if (s.status.value !== 'running') return false;
    }
    this.activate(s.id, true);
    this.prefill(s, prompt);
    return true;
  }

  /** Text at the prompt, not submitted. */
  prefill(s: Session, text: string) {
    s.view.paste(s.view.bracketedPaste ? text : oneLine(text));
  }

  /** New shells print a banner / prompt first: wait for output to settle (max ~3 s). */
  whenReady(s: Session, quietMs = 200, maxMs = 3000): Promise<void> {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const now = Date.now();
        if ((s.outputSeen && now - s.lastOutput >= quietMs) || now - t0 >= maxMs || s.status.value !== 'running') return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  applySettings() {
    const s = this.d.settings();
    if (this.spare && (!s.prewarm || this.spare.key !== this.spareKey())) this.dropSpare();
    for (const x of this.sessions.value) x.view.setOptions({ fontSize: s.fontSize, scrollback: s.scrollback, gpu: s.gpu });
  }

  applyTheme() {
    const theme = this.d.theme();
    if (theme) for (const x of this.sessions.value) x.view.setOptions({ theme });
  }

  applyFont() {
    const fontFamily = this.d.fontFamily();
    for (const x of this.sessions.value) x.view.setOptions({ fontFamily });
  }

  /** Refit the visible view (panel shown / resized). */
  fit() {
    this.active?.view.fit();
  }

  dispose() {
    this.disposed = true;
    this.dropSpare();
    this.offs.splice(0).forEach((f) => f());
    for (const s of this.sessions.value) {
      s.view.dispose();
      if (s.status.value === 'running') void this.d.backend.kill(s.id).catch(() => {});
    }
    this.sessions.value = [];
    this.activeId.value = null;
  }

  // ---- internals

  private openPath(t: LinkTarget) {
    this.d.openFile(t.path, t.line ? { line: t.line - 1, col: t.col ? t.col - 1 : 0 } : undefined);
  }

  private onData(id: number, data: string) {
    const s = this.find(id);
    if (!s) {
      if (this.closed.has(id)) return;
      // Output beats the session (the view is still being built): keep it, bounded, instead of dropping the prompt.
      const q = this.early.get(id) ?? [];
      if (q.reduce((n, x) => n + x.length, 0) + data.length <= MAX_EARLY) q.push(data);
      this.early.set(id, q);
      if (this.early.size > MAX_EARLY_IDS) this.early.delete(this.early.keys().next().value!);
      return;
    }
    const now = performance.now();
    const T = s.timing;
    if (T && !T.firstOutput) T.firstOutput = now;
    if (T && !T.prompt) {
      // The start-up burst ends when output stays quiet for a moment: that last chunk carried the prompt.
      clearTimeout(this.promptTimers.get(id));
      this.promptTimers.set(id, setTimeout(() => ((T.prompt = now), this.promptTimers.delete(id)), 150));
    }
    s.outputSeen = true;
    s.lastOutput = Date.now();
    s.view.write(data, () => this.d.backend.ack(id, data.length));
  }

  private onExit(id: number, code: number) {
    if (this.spare?.session.id === id) {
      // The spare's shell ended on its own: drop it (no respawn loop; the next terminal starts a new one).
      this.spare.session.status.value = 'exited';
      this.dropSpare();
      return;
    }
    const s = this.byId(id);
    if (!s) {
      if (this.closed.delete(id)) return; // the last word of a terminal we closed
      // Not registered: a shell that died while its view was being built (applied at registration) —
      // or the late exit of a closed one (its leftover output goes).
      if (this.starting.value) {
        this.earlyExit.set(id, code);
        if (this.earlyExit.size > MAX_EARLY_IDS) this.earlyExit.delete(this.earlyExit.keys().next().value!);
      } else this.early.delete(id);
      return;
    }
    s.status.value = 'exited';
    s.exitCode.value = code;
    // `exit` / Ctrl+D: the tab goes, like in other editors. A failure stays readable until a key is pressed.
    if (code === 0) return void this.close(id);
    s.view.write(`\r\n\x1b[2m[process exited with code ${code}, press any key to close]\x1b[0m\r\n`);
  }

  private mount(view: TerminalView) {
    if (!this.host) return;
    for (const el of [...this.host.children]) if (el !== view.element) (el as HTMLElement).remove();
    if (view.element.parentElement !== this.host) this.host.append(view.element);
    view.fit();
  }

  private mountActive() {
    const s = this.active;
    if (s) this.mount(s.view);
    else if (this.host) for (const el of [...this.host.querySelectorAll(':scope > .se-term-view')]) el.remove();
  }
}
