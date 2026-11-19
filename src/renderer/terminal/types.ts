// The manager talks to a terminal view through this interface: the real one is xterm.js (./view),
// tests use a fake. Keeps session logic testable without a canvas or a PTY.
import type { TermTheme } from './theme';

export type Off = () => void;
export type GpuMode = 'auto' | 'on' | 'off';

export interface FindOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
}

export interface LinkTarget {
  /** Workspace-relative file. */
  path: string;
  /** 1-based, as printed by the tool. */
  line?: number;
  col?: number;
}

export interface TerminalViewOptions {
  os: string;
  windowsBuild?: number;
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  theme: TermTheme | null;
  /** WebGL renderer: 'auto' = only on a hardware-accelerated GPU (software WebGL is slower than the DOM renderer). */
  gpu?: GpuMode;
  /** Links from the output (web-links addon, OSC 8 hyperlinks) — shell-controlled: validate before opening. */
  openUrl(url: string): void;
  /** A path printed in the output → workspace-relative file, or null (not a link). */
  resolvePath(raw: string): string | null;
  openPath(target: LinkTarget): void;
  /** Mod+F inside the terminal. */
  onFind(): void;
  /** Clipboard access failed (permission): explain instead of failing silently. */
  onClipboardError(what: 'copy' | 'paste'): void;
}

export interface TerminalView {
  /** Container to put in the panel; survives being detached while the panel is hidden. */
  readonly element: HTMLElement;
  readonly cols: number;
  readonly rows: number;
  /** The shell asked for bracketed paste (multi-line pastes are then not run line by line). */
  readonly bracketedPaste: boolean;
  /** Output from the PTY; `done` runs once it is parsed (flow-control ack). */
  write(data: string, done?: () => void): void;
  /** Text as if pasted by the user (honours bracketed paste, \n → \r). */
  paste(text: string): void;
  /** Refit to the container (after showing / resizing). */
  fit(): void;
  focus(): void;
  hasFocus(): boolean;
  hasSelection(): boolean;
  getSelection(): string;
  selectAll(): void;
  clearSelection(): void;
  clear(): void;
  /** The whole buffer (scrollback included) as text; wrapped rows joined, trailing blank lines dropped. */
  allText(): string;
  copySelection(): Promise<boolean>;
  pasteFromClipboard(): Promise<boolean>;
  findNext(query: string, o?: FindOptions): boolean;
  findPrevious(query: string, o?: FindOptions): boolean;
  clearFind(): void;
  onFindResults(cb: (r: { index: number; count: number }) => void): Off;
  setOptions(o: Partial<Pick<TerminalViewOptions, 'fontSize' | 'fontFamily' | 'scrollback' | 'theme' | 'windowsBuild' | 'gpu'>>): void;
  /** 'webgl' once the WebGL renderer is active, else 'dom'. */
  renderer?(): 'webgl' | 'dom';
  /** Size the buffer without a container (the hidden pre-warmed terminal). */
  setSize?(cols: number, rows: number): void;
  /** Measured cell size in CSS px (null until opened). */
  cellSize?(): { width: number; height: number } | null;
  /** Keystrokes / pastes typed into the view. */
  onInput(cb: (data: string) => void): Off;
  onResize(cb: (size: { cols: number; rows: number }) => void): Off;
  /** OSC 0/2 window title from the shell. */
  onTitle(cb: (title: string) => void): Off;
  dispose(): void;
}

export type CreateView = (o: TerminalViewOptions) => TerminalView | Promise<TerminalView>;
