// Fakes for the terminal UI tests: a backend that records calls and a view without xterm.js.
import type { ShellInfo, ShellList, TerminalDataEvent, TerminalExitEvent, TerminalSpawnRequest, TerminalSpawnResult } from '../../../src/shared/terminal';
import type { TerminalBackend } from '../../../src/renderer/terminal/backend';
import type { FindOptions, TerminalView, TerminalViewOptions } from '../../../src/renderer/terminal/types';
import { TerminalManager, type ManagerDeps } from '../../../src/renderer/terminal/manager';
import { TERMINAL_DEFAULTS, type TerminalSettings } from '../../../src/renderer/terminal/settings';

export const SHELLS: ShellInfo[] = [
  { id: 'bash', name: 'bash', kind: 'bash', path: '/bin/bash', args: [] },
  { id: 'zsh', name: 'zsh', kind: 'zsh', path: '/bin/zsh', args: [] },
  { id: 'cmd', name: 'Command Prompt', kind: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe', args: [] },
];

export class FakeBackend implements TerminalBackend {
  available = true;
  unavailableReason?: string;
  list: ShellList = { shells: SHELLS, defaultId: 'bash', platform: 'linux' };
  spawned: TerminalSpawnRequest[] = [];
  writes: Array<[number, string]> = [];
  resizes: Array<[number, number, number]> = [];
  acks: Array<[number, number]> = [];
  kills: number[] = [];
  listCalls = 0;
  /** withClaude flag of every listShells call. */
  listClaude: boolean[] = [];
  fail: Error | null = null;
  private nextId = 1;
  private data = new Set<(e: TerminalDataEvent) => void>();
  private exits = new Set<(e: TerminalExitEvent) => void>();
  async listShells(_refresh?: boolean, _prefer?: string, withClaude?: boolean) {
    this.listCalls++;
    this.listClaude.push(!!withClaude);
    return this.list;
  }
  async spawn(req: TerminalSpawnRequest): Promise<TerminalSpawnResult> {
    if (this.fail) throw this.fail;
    this.spawned.push(req);
    // Like main: an explicit id, else the preferred one when this machine has it, else the automatic default.
    const want = req.shellId ?? (req.prefer && this.list.shells.some((s) => s.id === req.prefer) ? req.prefer : this.list.defaultId);
    const shell = req.preset === 'claude' ? { id: 'claude', name: 'Claude Code', kind: 'claude' as const, path: '/usr/bin/claude', args: [] } : this.list.shells.find((s) => s.id === want)!;
    return { id: this.nextId++, pid: 1000 + this.nextId, shell, cwd: req.cwd ?? '' };
  }
  write(id: number, d: string) {
    this.writes.push([id, d]);
  }
  resize(id: number, c: number, r: number) {
    this.resizes.push([id, c, r]);
  }
  ack(id: number, n: number) {
    this.acks.push([id, n]);
  }
  async kill(id: number) {
    this.kills.push(id);
  }
  onData(cb: (e: TerminalDataEvent) => void) {
    this.data.add(cb);
    return () => this.data.delete(cb);
  }
  onExit(cb: (e: TerminalExitEvent) => void) {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
  emitData(id: number, data: string) {
    this.data.forEach((cb) => cb({ id, data }));
  }
  emitExit(id: number, exitCode: number) {
    this.exits.forEach((cb) => cb({ id, exitCode }));
  }
}

export class FakeView implements TerminalView {
  static all: FakeView[] = [];
  element = document.createElement('div');
  cols = 80;
  rows = 24;
  bracketedPaste = true;
  written = '';
  pasted: string[] = [];
  focused = false;
  disposed = false;
  fits = 0;
  selection = '';
  found: Array<[string, 1 | -1, FindOptions | undefined]> = [];
  options: Record<string, unknown> = {};
  private input = new Set<(d: string) => void>();
  private resize = new Set<(s: { cols: number; rows: number }) => void>();
  private title = new Set<(t: string) => void>();
  private results = new Set<(r: { index: number; count: number }) => void>();
  constructor(public o: TerminalViewOptions) {
    this.element.className = 'se-term-view';
    FakeView.all.push(this);
  }
  write(d: string, done?: () => void) {
    this.written += d;
    done?.();
  }
  paste(t: string) {
    this.pasted.push(t);
    this.input.forEach((cb) => cb(t)); // xterm turns a paste into onData
  }
  fit() {
    this.fits++;
  }
  focus() {
    this.focused = true;
  }
  hasFocus() {
    return this.focused;
  }
  hasSelection() {
    return !!this.selection;
  }
  getSelection() {
    return this.selection;
  }
  selectAll() {}
  clearSelection() {
    this.selection = '';
  }
  clear() {
    this.written = '';
  }
  allText() {
    return this.written.replace(/\r/g, '').trimEnd();
  }
  async copySelection() {
    return !!this.selection;
  }
  async pasteFromClipboard() {
    return true;
  }
  findNext(q: string, o?: FindOptions) {
    this.found.push([q, 1, o]);
    this.results.forEach((cb) => cb({ index: 0, count: 3 }));
    return true;
  }
  findPrevious(q: string, o?: FindOptions) {
    this.found.push([q, -1, o]);
    return true;
  }
  clearFind() {}
  onFindResults(cb: (r: { index: number; count: number }) => void) {
    this.results.add(cb);
    return () => this.results.delete(cb);
  }
  setOptions(o: Record<string, unknown>) {
    Object.assign(this.options, o);
  }
  onInput(cb: (d: string) => void) {
    this.input.add(cb);
    return () => this.input.delete(cb);
  }
  onResize(cb: (s: { cols: number; rows: number }) => void) {
    this.resize.add(cb);
    return () => this.resize.delete(cb);
  }
  onTitle(cb: (t: string) => void) {
    this.title.add(cb);
    return () => this.title.delete(cb);
  }
  dispose() {
    this.disposed = true;
    this.element.remove();
  }
  // test helpers
  type(d: string) {
    this.input.forEach((cb) => cb(d));
  }
  setSize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  resizeTo(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resize.forEach((cb) => cb({ cols, rows }));
  }
  setTitle(t: string) {
    this.title.forEach((cb) => cb(t));
  }
}

export interface Rig {
  m: TerminalManager;
  b: FakeBackend;
  host: HTMLElement;
  toasts: string[];
  opened: Array<[string, unknown]>;
  urls: string[];
  confirms: string[];
  settings: TerminalSettings;
  state: { root: string | null; confirm: boolean; empty: number; find: number };
}

export function managerRig(over: Partial<ManagerDeps> = {}): Rig {
  const b = new FakeBackend();
  const host = document.createElement('div');
  document.body.append(host);
  const toasts: string[] = [];
  const opened: Array<[string, unknown]> = [];
  const urls: string[] = [];
  const confirms: string[] = [];
  const settings: TerminalSettings = { ...TERMINAL_DEFAULTS };
  const state = { root: '/home/me/proj' as string | null, confirm: true, empty: 0, find: 0 };
  const m = new TerminalManager({
    backend: b,
    createView: (o) => new FakeView(o),
    os: 'linux',
    settings: () => settings,
    workspaceRoot: () => state.root,
    files: () => new Set(['src/a.ts', 'sub/b.md']),
    openFile: (p, at) => void opened.push([p, at]),
    openUrl: (u) => void urls.push(u),
    toast: (msg) => void toasts.push(msg),
    confirm: async (title) => (confirms.push(title), state.confirm),
    fontFamily: () => 'monospace',
    theme: () => null,
    onEmpty: () => void state.empty++,
    onFind: () => void state.find++,
    ...over,
  });
  m.setHost(host);
  return { m, b, host, toasts, opened, urls, confirms, settings, state };
}

export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
