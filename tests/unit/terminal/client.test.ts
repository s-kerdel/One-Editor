// @vitest-environment happy-dom
// Renderer-side pieces: key policy, settings, backend client, theme tokens, xterm line mapping, install stub.
import { describe, it, expect, beforeEach } from 'vitest';
import { appKeyWinsInTerminal, terminalKeyAction, type KeyLike } from '../../../src/renderer/terminal/keys';
import { readTerminalSettings, TERMINAL_DEFAULTS, TERMINAL_SETTING_DEFS } from '../../../src/renderer/terminal/settings';
import { bridgeTerminalBackend, connectTerminalBackend, splitForWrite, type TerminalBridgeLike } from '../../../src/renderer/terminal/backend';
import { readTerminalTheme, sameTheme, THEME_VARS, canvasColorResolver } from '../../../src/renderer/terminal/theme';
import { lineCells } from '../../../src/renderer/terminal/view';
import { normalizeKey, getCommand } from '../../../src/renderer/app/commands';
import { TERMINAL_LIMITS } from '../../../src/shared/terminal';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ type: 'keydown', key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

describe('terminal key policy', () => {
  it('Windows: Ctrl+Shift+C/V, Ctrl+C copies only with a selection, Ctrl+V pastes, Ctrl+F finds', () => {
    const w = (e: KeyLike, sel = false) => terminalKeyAction(e, { os: 'win32', hasSelection: sel });
    expect(w(key('C', { ctrlKey: true, shiftKey: true }), true)).toBe('copy');
    expect(w(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('none'); // never a stray ^C
    expect(w(key('c', { ctrlKey: true }), true)).toBe('copy');
    expect(w(key('c', { ctrlKey: true }), false)).toBeNull(); // ^C → SIGINT
    expect(w(key('v', { ctrlKey: true }))).toBe('paste');
    expect(w(key('V', { ctrlKey: true, shiftKey: true }))).toBe('paste');
    expect(w(key('f', { ctrlKey: true }))).toBe('find');
    expect(w(key('Insert', { shiftKey: true }))).toBe('paste');
    expect(w(key('Insert', { ctrlKey: true }), true)).toBe('copy');
    expect(w(key('w', { ctrlKey: true }))).toBeNull();
    expect(w(key('с', { ctrlKey: true, code: 'KeyC' }), true)).toBe('copy'); // Cyrillic layout
  });

  it('Linux: Ctrl+C / Ctrl+V stay with the shell (readline), Shift variants copy/paste', () => {
    const l = (e: KeyLike, sel = true) => terminalKeyAction(e, { os: 'linux', hasSelection: sel });
    expect(l(key('c', { ctrlKey: true }))).toBeNull();
    expect(l(key('v', { ctrlKey: true }))).toBeNull();
    expect(l(key('C', { ctrlKey: true, shiftKey: true }))).toBe('copy');
    expect(l(key('a', { ctrlKey: true }))).toBeNull();
  });

  it('macOS: Cmd+C/V/F/A/K are the terminal’s; Ctrl keys go to the shell', () => {
    const m = (e: KeyLike, sel = true) => terminalKeyAction(e, { os: 'darwin', hasSelection: sel });
    expect(m(key('c', { metaKey: true }))).toBe('copy');
    expect(m(key('c', { metaKey: true }), false)).toBe('none');
    expect(m(key('v', { metaKey: true }))).toBe('paste');
    expect(m(key('k', { metaKey: true }))).toBe('clear');
    expect(m(key('c', { ctrlKey: true }))).toBeNull();
  });

  it('only a short list of app shortcuts beats the shell on Windows/Linux; on macOS all but the terminal’s own', () => {
    for (const k of ['Mod-`', 'Mod-Shift-p', 'Mod-p', 'Mod-s', 'Ctrl-Tab', 'Mod-,']) expect(appKeyWinsInTerminal(k, 'win32'), k).toBe(true);
    for (const k of ['Mod-w', 'Mod-e', 'Mod-n', 'Mod-t', 'Mod-k', 'Mod-b', 'Mod-\\', 'Mod-o', 'F1', 'F4']) expect(appKeyWinsInTerminal(k, 'linux'), k).toBe(false);
    expect(appKeyWinsInTerminal('Mod-w', 'darwin')).toBe(true);
    expect(appKeyWinsInTerminal('Mod-c', 'darwin')).toBe(false);
    expect(appKeyWinsInTerminal('Ctrl-`', 'darwin')).toBe(true); // Mac: Cmd+` is the OS's, Ctrl+` toggles the panel
  });
});

describe('terminal settings', () => {
  it('reads, validates and clamps', () => {
    expect(readTerminalSettings({})).toEqual(TERMINAL_DEFAULTS);
    expect(TERMINAL_DEFAULTS).toMatchObject({ scrollback: 2000, gpu: 'auto', prewarm: false }); // scrollback is per terminal (memory)
    expect(readTerminalSettings({ 'terminal.defaultShell': ' wsl:Ubuntu ', 'terminal.fontSize': 99, 'terminal.scrollback': 12.4, 'terminal.runPressesEnter': true, 'terminal.gpuAcceleration': 'off', 'terminal.prewarm': true })).toEqual({ defaultShell: 'wsl:Ubuntu', fontSize: 32, scrollback: 100, runPressesEnter: true, gpu: 'off', prewarm: true, followClaude: true });
    expect(readTerminalSettings({ 'terminal.gpuAcceleration': 'maybe', 'terminal.prewarm': 'yes' })).toMatchObject({ gpu: 'auto', prewarm: false });
    expect(readTerminalSettings({ 'terminal.defaultShell': 'C:\\evil.exe', 'terminal.fontSize': '14', 'terminal.runPressesEnter': 'yes' })).toEqual(TERMINAL_DEFAULTS);
  });

  it('registry entries follow the registry rules (short one-line descriptions, defaults in range)', () => {
    expect(TERMINAL_SETTING_DEFS.map((d) => d.key)).toEqual(['terminal.defaultShell', 'terminal.fontSize', 'terminal.scrollback', 'terminal.runPressesEnter', 'terminal.prewarm', 'terminal.gpuAcceleration', 'claude.follow']);
    for (const d of TERMINAL_SETTING_DEFS) {
      expect(d.description.length, d.key).toBeLessThanOrEqual(100);
      expect(d.description).not.toContain('\n');
      if (d.control.type === 'number') {
        expect(d.default as number).toBeGreaterThanOrEqual(d.control.min);
        expect(d.default as number).toBeLessThanOrEqual(d.control.max);
      }
    }
  });
});

describe('terminal backend client', () => {
  it('splits big writes below the main-process cap without breaking surrogate pairs', () => {
    const emoji = '😀'.repeat(40000); // 80 000 UTF-16 units
    const parts = splitForWrite(emoji);
    expect(parts.join('')).toBe(emoji);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TERMINAL_LIMITS.maxWriteChars);
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)).toBe(false);
    }
    expect(splitForWrite('ls\r')).toEqual(['ls\r']);
  });

  it('unwraps replies into results / RpcErrors and flattens data batches', async () => {
    const sent: unknown[][] = [];
    let onData: (p: unknown) => void = () => {};
    const bridge: TerminalBridgeLike = {
      shells: async () => ({ ok: true, result: { shells: [], defaultId: null, platform: 'linux' } }),
      spawn: async () => ({ ok: false, error: { code: 'ELIMIT', message: 'Too many terminals' } }),
      kill: async () => ({ ok: true, result: true }),
      write: (...a) => void sent.push(['w', ...a]),
      resize: (...a) => void sent.push(['r', ...a]),
      ack: (...a) => void sent.push(['a', ...a]),
      onData: (cb) => ((onData = cb), () => {}),
      onExit: () => () => {},
    };
    const b = bridgeTerminalBackend(bridge);
    expect(b.available).toBe(true);
    expect((await b.listShells()).platform).toBe('linux');
    await expect(b.spawn({})).rejects.toMatchObject({ code: 'ELIMIT', message: 'Too many terminals' });
    await b.kill(1);
    b.write(1, 'x'.repeat(40000));
    expect(sent.filter((s) => s[0] === 'w')).toHaveLength(2);
    const got: unknown[] = [];
    b.onData((e) => got.push(e));
    onData([{ id: 1, data: 'a' }, { id: 2, data: 'b' }]);
    onData('garbage');
    expect(got).toEqual([{ id: 1, data: 'a' }, { id: 2, data: 'b' }]);
  });

  it('no preload bridge (browser) → unavailable, every call refused with ENOTSUP', async () => {
    const b = connectTerminalBackend({});
    expect(b.available).toBe(false);
    expect(b.unavailableReason).toMatch(/desktop app only/);
    await expect(b.spawn({})).rejects.toMatchObject({ code: 'ENOTSUP' });
    expect(connectTerminalBackend({ secEditBridge: { terminal: {} } }).available).toBe(true);
  });
});

describe('terminal theme', () => {
  it('reads every --se-term-* token from the element (falls back for missing ones)', () => {
    const el = document.createElement('div');
    const values: Record<string, string> = { '--se-term-bg': '#101010', '--se-term-fg': '#eeeeee', '--se-term-red': 'rgb(255, 0, 0)' };
    const view = { getComputedStyle: () => ({ getPropertyValue: (k: string) => values[k] ?? '' }) } as unknown as Window;
    const seen: Array<[string, unknown]> = [];
    const t = readTerminalTheme(el, (c, o) => (seen.push([c, o?.opaqueOver]), c), view);
    expect(t).toMatchObject({ background: '#101010', foreground: '#eeeeee', red: 'rgb(255, 0, 0)', cursor: '#7aa2f7' });
    expect(Object.keys(t).sort()).toEqual(Object.keys(THEME_VARS).sort());
    expect(seen.find(([c]) => c === '#101010')).toBeTruthy();
    expect(sameTheme(t, { ...t })).toBe(true);
    expect(sameTheme(t, { ...t, red: '#000' })).toBe(false);
    expect(sameTheme(null, t)).toBe(false);
  });

  it('without a canvas (tests / headless) colours pass through unchanged', () => {
    expect(canvasColorResolver()(' #abcdef ')).toBe('#abcdef');
  });
});

describe('xterm line → text mapping (links on lines with wide characters)', () => {
  it('maps UTF-16 offsets to cells, skipping the second half of wide chars', () => {
    const cells = [
      ['界', 2],
      ['', 0],
      [' ', 1],
      ['a', 1],
      ['😀', 2],
      ['', 0],
      ['b', 1],
    ] as const;
    const line = { length: cells.length, getCell: (x: number) => ({ getChars: () => cells[x][0], getWidth: () => cells[x][1] }) } as never;
    const { text, cellOf } = lineCells(line);
    expect(text).toBe('界 a😀b');
    expect(cellOf).toEqual([0, 2, 3, 4, 4, 6]);
  });
});

describe('install stub (startup) + entry (lazy)', () => {
  beforeEach(() => {
    delete (globalThis as { secEditBridge?: unknown }).secEditBridge;
  });
  it('startup registers only Ctrl+` (same metadata as the real command); entry adds the rest', async () => {
    const { installTerminal } = await import('../../../src/renderer/terminal/install');
    const { app } = await import('../../../src/renderer/app/app');
    installTerminal();
    const stub = getCommand('terminal.toggle')!;
    expect(stub.keys).toEqual(['Mod-`', 'Ctrl-`']);
    expect(getCommand('terminal.new')).toBeUndefined(); // arrives with the idle chunk
    expect(app.runInTerminal).toBeUndefined(); // browser build: no bridge, no "Run in terminal"
    const meta = (c: ReturnType<typeof getCommand>) => ({ id: c!.id, title: c!.title, category: c!.category, keys: c!.keys, hasWhen: !!c!.when });
    const before = meta(stub);

    await import('../../../src/renderer/terminal/entry');
    const real = getCommand('terminal.toggle')!;
    expect(real).not.toBe(stub);
    expect(meta(real)).toEqual(before);
    expect(getCommand('terminal.new')!.keys!.map(normalizeKey)).toEqual(['Mod-Shift-`', 'Mod-Shift-~', 'Ctrl-Shift-`', 'Ctrl-Shift-~']);
    expect(getCommand('terminal.new')!.when!()).toBe(false); // desktop only
    for (const id of ['terminal.newWithShell', 'terminal.selectDefaultShell', 'terminal.kill', 'terminal.clear', 'terminal.rename', 'terminal.next', 'terminal.prev', 'terminal.runSelection', 'claude.open', 'claude.askFile', 'claude.askSelection']) expect(getCommand(id), id).toBeTruthy();
    // The palette shows "<category>: <title>" → "Claude: Ask about this file".
    expect(getCommand('claude.askFile')).toMatchObject({ category: 'Claude', title: 'Ask about this file' });
    expect(getCommand('claude.askSelection')).toMatchObject({ category: 'Claude', title: 'Ask about selection' });
    expect(getCommand('terminal.toggle')).toMatchObject({ category: 'Terminal', title: 'Toggle panel' });
  });
});

describe('GPU renderer choice', () => {
  it('software WebGL counts as "no GPU" (it draws slower than the DOM renderer)', async () => {
    const { isSoftwareGl } = await import('../../../src/renderer/terminal/view');
    for (const r of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)']) expect(isSoftwareGl(r), r).toBe(true);
    for (const r of ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple M2']) expect(isSoftwareGl(r), r).toBe(false);
  });
});


describe('toggle while opening', () => {
  it('a second Ctrl+` during the open (key repeat, double press) does not hide the panel again', async () => {
    const { toggleTerminal, hideTerminal } = await import('../../../src/renderer/terminal/entry');
    const { panelOpen } = await import('../../../src/renderer/terminal/state');
    await toggleTerminal(); // loads the implementation (the real race needs it loaded: idle warm-up does that)
    hideTerminal();
    expect(panelOpen.value).toBe(false);
    const first = toggleTerminal();
    const second = toggleTerminal(); // arrives before the first finished opening
    await Promise.all([first, second]);
    expect(panelOpen.value).toBe(true);
    await toggleTerminal(); // a real second press later still toggles (nothing focused → hides)
    expect(panelOpen.value).toBe(false);
  });
});
