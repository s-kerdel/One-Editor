// "Ask Claude" prompts: what gets typed (never submitted) into a Claude Code terminal.
// Claude Code reads `@path` mentions itself, so the prompt only names the file, the lines and —
// when short — quotes the selection. Pure (unit-tested).

export interface ClaudeAsk {
  /** Workspace-relative POSIX path. */
  path: string;
  /** 1-based, inclusive. */
  startLine?: number;
  endLine?: number;
  text?: string;
}

/** Longer selections are referenced by line range only (Claude reads the file). */
export const QUOTE_LIMIT = 600;

// Control characters could drive the TUI (ESC sequences, ^C, ^D…); tabs and newlines are fine.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function claudePrompt(a: ClaudeAsk): string {
  const path = a.path.replace(CONTROL, '');
  // `@` mentions of paths with spaces are not documented: name such a file in quotes instead.
  const ref = /\s/.test(path) ? `"${path}"` : `@${path}`;
  if (!a.startLine) return `${ref} `;
  const end = a.endLine && a.endLine > a.startLine ? a.endLine : a.startLine;
  const lines = end > a.startLine ? `lines ${a.startLine}-${end}` : `line ${a.startLine}`;
  const text = (a.text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\s+$/, '');
  if (!text.trim() || text.length > QUOTE_LIMIT) return `${ref} ${lines} `;
  if (!text.includes('\n')) return `${ref} ${lines}: "${text.trim()}" `;
  const fence = text.includes('```') ? '~~~~' : '```';
  return `${ref} ${lines}:\n${fence}\n${text}\n${fence}\n`;
}

/** A prompt typed into a TUI without bracketed paste would submit at every newline: make it one line. */
export const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/ +$/, ' ');
