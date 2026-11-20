// "Run in terminal" for fenced shell code blocks. Dependency-free: the editor and preview chunks
// import isRunnableFence() to decide whether to draw the ▶ button, without pulling in the terminal.

const RUNNABLE = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'shellsession', 'shell-session', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch']);
/** Transcripts: prompt lines are commands, everything else is output. */
const TRANSCRIPT = new Set(['console', 'shellsession', 'shell-session']);

/** Fence info → can its content be pasted into a shell? (`bash title=x` → first word only) */
export function isRunnableFence(info: string | null | undefined): boolean {
  const word = (info ?? '').trim().split(/[\s{]/)[0].toLowerCase();
  return RUNNABLE.has(word);
}

const PROMPT = /^\s*[$>](?: |$)/;
/**
 * C0 / C1 control characters except tab and newline. Text from a file must not carry them into a
 * terminal: Ctrl-O (0x0F) is readline's "accept line" — a command would run without Enter —, ESC starts
 * terminal sequences, Ctrl-C / Ctrl-D / Ctrl-Z act on the running program.
 */
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Code block → text to paste:
 *  - `console` transcripts: keep only the prompt lines (`$ cmd`, `> continuation`), prompts removed;
 *  - any shell block where EVERY command line starts with `$ ` (README style): strip the `$ `;
 *  - surrounding blank lines and the trailing newline go (pasting never presses Enter by itself);
 *  - control characters go (CONTROL): an invisible byte in a note must not act as a key press.
 */
export function prepareRunText(code: string, info?: string | null): string {
  const lang = (info ?? '').trim().split(/[\s{]/)[0].toLowerCase();
  let lines = code.replace(/\r\n?/g, '\n').replace(CONTROL, '').split('\n');
  const strip = (l: string) => l.replace(PROMPT, '');
  if (TRANSCRIPT.has(lang) && lines.some((l) => PROMPT.test(l))) {
    lines = lines.filter((l) => PROMPT.test(l)).map(strip);
  } else {
    const nonBlank = lines.filter((l) => l.trim());
    if (nonBlank.length && nonBlank.every((l) => /^\s*\$ /.test(l))) lines = lines.map((l) => l.replace(/^\s*\$ /, ''));
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}
