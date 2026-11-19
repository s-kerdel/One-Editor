// Contracts between the editor chunk (./cm.ts: chips, completion, code-block buttons) and the lazy
// variables chunk (./index.ts: parsing, resolution, vault, UI). Types only.
import type { EditorView } from '@codemirror/view';

export interface ChipView {
  /** What the chip shows (secret → ••••, unresolved → {{name}}?). */
  text: string;
  cls: 'ok' | 'secret' | 'missing' | 'default' | 'secret-missing';
  /** Hover lines: "ns = prod", "variables.md · env prod", "overridden in this note (variables.md has X)". */
  tip: string[];
}

export interface CodeHeaderVars {
  /** "powershell on a linux target" or null. */
  os: string | null;
  /** Show "Copy / Run for targets…". */
  multi: boolean;
}

/** Live-mode provider (sync: decorations are built synchronously; data arrives via refreshVariables()). */
export interface VarsProvider {
  readonly showValues: boolean;
  /** variables.md itself (definitions: no chips, linted instead), or a template. */
  skipChips(path: string): boolean;
  isVarsFile(path: string): boolean;
  chip(path: string, fm: string, info: string | null, name: string, dflt: string | undefined): ChipView;
  codeHeader(path: string, fm: string, info: string): CodeHeaderVars | null;
  completions(path: string, fm: string, info: string | null): Array<{ label: string; detail: string; info?: string; boost?: number }>;
  editChip(anchor: HTMLElement, path: string, fm: string, info: string | null, name: string): void;
  /** Alt-hover on a secret chip. */
  reveal(path: string, fm: string, info: string | null, name: string): Promise<string | null>;
  lintView(view: EditorView): void;
}

export interface CodeCtx {
  path: string;
  /** Full fence info string (`bash {target=DC01}`). */
  info: string;
}

/** `app.variables`: what preview / export / code-block buttons use. Stubbed by ./cm until the chunk loads. */
export interface VariablesApi {
  /** markdown-it hook for a note (text + code, secrets masked); null = leave placeholders raw. */
  renderHook(path: string, opts?: { export?: boolean }): ((text: string, info: string | null) => string) | null;
  copyCode(code: string, ctx: CodeCtx): Promise<boolean>;
  runCode(code: string, ctx: CodeCtx): Promise<boolean>;
  /** "Copy / Run for targets…" dialog. */
  forTargets(code: string, ctx: CodeCtx): Promise<void>;
  hasTargets(path: string): boolean;
  /** Load what `path` resolves against (export waits for it). */
  prepare(path: string): Promise<void>;
  /** Smart paste "as template": put values into the note's variables.md (secrets → vault). Returns
   *  renames (name → name used) when a name already holds a different value. */
  saveValues(path: string, values: Array<{ name: string; value: string; secret: boolean }>): Promise<Map<string, string>>;
}
