// @vitest-environment happy-dom
// The real xterm.js view, headless (happy-dom has no layout/canvas): output parsing + acks, paste →
// input with bracketed paste, OSC titles, link provider wiring, dispose. Rendering is covered by E2E.
import { describe, it, expect } from 'vitest';
import { createXtermView } from '../../../src/renderer/terminal/view';
import type { TerminalViewOptions } from '../../../src/renderer/terminal/types';

const opts = (over: Partial<TerminalViewOptions> = {}): TerminalViewOptions => ({
  os: 'linux',
  fontSize: 13,
  fontFamily: 'monospace',
  scrollback: 1000,
  theme: null,
  openUrl: () => {},
  resolvePath: () => null,
  openPath: () => {},
  onFind: () => {},
  onClipboardError: () => {},
  ...over,
});
const written = (v: ReturnType<typeof createXtermView>, s: string) => new Promise<void>((r) => v.write(s, r));

describe('xterm view (headless)', () => {
  it('parses output (write callback = flow-control ack), titles and bracketed paste', async () => {
    const v = createXtermView(opts());
    const input: string[] = [];
    const titles: string[] = [];
    v.onInput((d) => input.push(d));
    v.onTitle((t) => titles.push(t));
    await written(v, 'hello\r\n\x1b]0;my title\x07');
    expect(titles).toEqual(['my title']);
    expect(v.cols).toBe(80);
    v.paste('a\nb');
    expect(input.at(-1)).toBe('a\rb'); // no bracketed paste yet: \n → \r
    expect(v.bracketedPaste).toBe(false);
    await written(v, '\x1b[?2004h'); // the shell enables bracketed paste
    expect(v.bracketedPaste).toBe(true);
    v.paste('ls');
    expect(input.at(-1)).toBe('\x1b[200~ls\x1b[201~');
    v.paste('echo hi\x1b[201~rm -rf ~\n'); // a crafted block must not close the bracket and run
    expect(input.at(-1)).toBe('\x1b[200~echo hirm -rf ~\r\x1b[201~');
    // Not opened yet (no layout): selection / clear / fit must be harmless no-ops, not crashes.
    v.selectAll();
    v.clear();
    v.fit();
    expect(v.hasFocus()).toBe(false);
    v.dispose();
  });
});
