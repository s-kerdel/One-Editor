// @vitest-environment happy-dom
// TerminalManager with a fake backend + fake views: sessions, routing, exits, run-in-terminal.
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeView, flush, managerRig } from './fakes';
import { cleanTitle } from '../../../src/renderer/terminal/manager';
import { SHELLS } from './fakes';

beforeEach(() => {
  FakeView.all = [];
  document.body.innerHTML = '';
});
const view = (i = -1) => FakeView.all.at(i)!;

describe('TerminalManager: sessions', () => {
  it('creates a terminal with the automatic default shell, sized like the mounted view', async () => {
    const r = managerRig();
    const s = (await r.m.create())!;
    // Spawned without waiting for the shell list: main resolves the default.
    expect(r.b.spawned).toEqual([{ shellId: undefined, prefer: undefined, cwd: undefined, cols: 80, rows: 24 }]);
    expect(s.shell.id).toBe('bash');
    expect(s).toMatchObject({ id: 1, cwd: '' });
    expect(s.title.value).toBe('bash');
    expect(r.m.activeId.value).toBe(1);
    expect(r.host.contains(view().element)).toBe(true);
    expect(view().fits).toBeGreaterThan(0);
    expect(view().focused).toBe(true);
  });

  it('honours terminal.defaultShell when this machine has it, else falls back', async () => {
    const r = managerRig();
    r.settings.defaultShell = 'zsh';
    await r.m.create();
    r.settings.defaultShell = 'fish'; // not installed
    await r.m.create();
    expect(r.b.spawned.map((x) => x.prefer).slice(0, 2)).toEqual(['zsh', 'fish']); // the setting travels as a preference…
    expect(r.m.sessions.value.map((x) => x.shell.id).slice(0, 2)).toEqual(['zsh', 'bash']); // …main falls back when missing
    expect(r.b.listCalls).toBe(2); // cached, but re-asked when the default-shell setting changed (Claude lookup follows it)
    await r.m.create();
    expect(r.b.listCalls).toBe(2);
  });

  it('no folder → no terminal, a clear message instead', async () => {
    const r = managerRig();
    r.state.root = null;
    expect(await r.m.create()).toBeNull();
    expect(r.m.error.value).toMatch(/Open a folder/);
    expect(r.b.spawned).toEqual([]);
  });

  it('a failed spawn disposes its view, keeps the previous terminal visible and reports the error', async () => {
    const r = managerRig();
    await r.m.create();
    const first = view();
    r.b.fail = Object.assign(new Error('Too many terminals (max 10)'), { code: 'ELIMIT' });
    expect(await r.m.create()).toBeNull();
    expect(view().disposed).toBe(true);
    expect(r.host.contains(first.element)).toBe(true);
    expect(r.toasts).toEqual(['Terminal: Too many terminals (max 10)']);
    expect(r.m.error.value).toMatch(/Too many/);
    expect(r.m.sessions.value).toHaveLength(1);
  });

  it('routes output to the right view and acks what it parsed; early output is not lost', async () => {
    const r = managerRig();
    r.b.emitData(1, 'early prompt$ '); // beats the spawn reply
    const a = (await r.m.create())!;
    const b = (await r.m.create())!;
    r.b.emitData(b.id, 'two');
    r.b.emitData(a.id, ' one');
    expect(FakeView.all[0].written).toBe('early prompt$  one');
    expect(FakeView.all[1].written).toBe('two');
    expect(r.b.acks).toEqual([
      [1, 14],
      [2, 3],
      [1, 4],
    ]);
  });

  it('keystrokes, resizes and OSC titles flow to the backend / tab', async () => {
    const r = managerRig();
    const s = (await r.m.create())!;
    view().type('ls\r');
    view().resizeTo(120, 33);
    view().setTitle('vim notes.md');
    expect(r.b.writes).toEqual([[s.id, 'ls\r']]);
    expect(r.b.resizes).toEqual([[s.id, 120, 33]]);
    expect(s.title.value).toBe('vim notes.md');
    r.m.rename(s.id, '  build  ');
    view().setTitle('something else');
    expect(s.title.value).toBe('build'); // a user's name wins over the shell's
    r.m.rename(s.id, '');
    expect(s.title.value).toBe('bash');
  });

  it('`exit` (code 0) closes the tab; a failure stays readable until a key is pressed', async () => {
    const r = managerRig();
    const a = (await r.m.create())!;
    const b = (await r.m.create())!;
    r.b.emitExit(b.id, 0);
    expect(r.m.sessions.value.map((s) => s.id)).toEqual([a.id]);
    expect(r.b.kills).toEqual([]); // already gone: nothing to kill
    expect(r.m.activeId.value).toBe(a.id);
    r.b.emitExit(a.id, 2);
    expect(a.status.value).toBe('exited');
    expect(view(0).written).toContain('process exited with code 2');
    view(0).type('x');
    await flush();
    expect(r.m.sessions.value).toEqual([]);
    expect(r.b.writes).toEqual([]); // nothing is written to a dead shell
    expect(r.state.empty).toBe(1);
  });

  it('close() kills the shell, picks the neighbour tab and signals "empty" after the last one', async () => {
    const r = managerRig();
    const [a, b, c] = [(await r.m.create())!, (await r.m.create())!, (await r.m.create())!];
    r.m.activate(b.id);
    await r.m.close(b.id);
    expect(r.b.kills).toEqual([b.id]);
    expect(r.m.activeId.value).toBe(c.id);
    expect(r.host.contains(view(2).element)).toBe(true);
    expect(view(1).disposed).toBe(true);
    r.m.cycle(1);
    expect(r.m.activeId.value).toBe(a.id);
    await r.m.closeAll();
    expect(r.b.kills.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(r.state.empty).toBe(1);
    expect(r.host.children).toHaveLength(0);
  });

  it('settings changes reach every view', async () => {
    const r = managerRig();
    await r.m.create();
    await r.m.create();
    r.settings.fontSize = 17;
    r.settings.scrollback = 900;
    r.m.applySettings();
    for (const v of FakeView.all) expect(v.options).toMatchObject({ fontSize: 17, scrollback: 900 });
  });

  it('path links resolve against the shell’s folder and open at the printed (1-based) position', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list };
    await r.m.create({ cwd: 'sub' });
    const o = view().o;
    expect(o.resolvePath('b.md')).toBe('sub/b.md');
    expect(o.resolvePath('/home/me/proj/src/a.ts')).toBe('src/a.ts');
    expect(o.resolvePath('nope.ts')).toBeNull();
    o.openPath({ path: 'src/a.ts', line: 12, col: 3 });
    o.openPath({ path: 'sub/b.md' });
    expect(r.opened).toEqual([
      ['src/a.ts', { line: 11, col: 2 }],
      ['sub/b.md', undefined],
    ]);
    o.onFind();
    expect(r.state.find).toBe(1);
  });

  it('OSC titles are sanitised', () => {
    expect(cleanTitle('\u001b]evil\u0007 title', SHELLS[0])).toBe(']evil title');
    expect(cleanTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe', SHELLS[0])).toBeNull();
    expect(cleanTitle('x'.repeat(200), SHELLS[0])!.length).toBe(60);
    expect(cleanTitle('/bin/bash', SHELLS[0])).toBeNull();
  });
});

describe('TerminalManager: run in terminal', () => {
  it('pastes into the active terminal without pressing Enter (prompts stripped)', async () => {
    const r = managerRig();
    const s = (await r.m.create())!;
    expect(await r.m.run('$ npm install\nadded 1 package\n', { lang: 'console' })).toBe(true);
    expect(view().pasted).toEqual(['npm install']);
    expect(r.b.writes).toEqual([[s.id, 'npm install']]);
  });

  it('presses Enter when asked (option or terminal.runPressesEnter)', async () => {
    const r = managerRig();
    const s = (await r.m.create())!;
    await r.m.run('make', { pressEnter: true });
    r.settings.runPressesEnter = true;
    await r.m.run('make test');
    await r.m.run('ls', { pressEnter: false });
    expect(r.b.writes).toEqual([
      [s.id, 'make'],
      [s.id, '\r'],
      [s.id, 'make test'],
      [s.id, '\r'],
      [s.id, 'ls'],
    ]);
  });

  it('starts a terminal when none is running and waits for its prompt first', async () => {
    const r = managerRig();
    const p = r.m.run('echo hi');
    await flush(20);
    expect(r.b.spawned).toHaveLength(1);
    expect(view().pasted).toEqual([]); // still waiting for the shell to print something
    r.b.emitData(1, 'PS C:\\> ');
    expect(await p).toBe(true);
    expect(view().pasted).toEqual(['echo hi']);
  });

  it('multi-line text in a shell without bracketed paste asks first', async () => {
    const r = managerRig();
    await r.m.create();
    view().bracketedPaste = false;
    r.state.confirm = false;
    expect(await r.m.run('cd x\nmake')).toBe(false);
    expect(view().pasted).toEqual([]);
    r.state.confirm = true;
    expect(await r.m.run('cd x\nmake')).toBe(true);
    expect(view().pasted).toEqual(['cd x\nmake']);
    expect(r.confirms).toHaveLength(2);
    view().bracketedPaste = true;
    await r.m.run('a\nb');
    expect(r.confirms).toHaveLength(2); // bracketed paste: the shell shows it, nothing runs early
  });

  it('nothing to run → no terminal is started', async () => {
    const r = managerRig();
    expect(await r.m.run('\n  \n')).toBe(false);
    expect(r.b.spawned).toEqual([]);
  });
});

describe('TerminalManager: pre-warmed spare (terminal.prewarm)', () => {
  it('off by default: no hidden shell', async () => {
    const r = managerRig();
    await r.m.create();
    await flush(450);
    expect(r.b.spawned).toHaveLength(1);
    expect(r.m.spareSession).toBeNull();
  });

  it('on: after the first terminal a hidden one starts; the next "new terminal" takes it instantly', async () => {
    const r = managerRig();
    r.settings.prewarm = true;
    const first = (await r.m.create())!;
    await flush(450);
    expect(r.b.spawned).toHaveLength(2); // the spare
    const spare = r.m.spareSession!;
    expect(spare).toBeTruthy();
    expect(r.m.sessions.value).toEqual([first]); // invisible: no tab
    r.b.emitData(spare.id, 'term$ ');
    expect((spare.view as FakeView).written).toBe('term$ '); // its output is parsed while hidden…
    expect(r.b.acks.at(-1)).toEqual([spare.id, 6]); // …and acked (no flow-control stall)
    const second = (await r.m.create())!;
    expect(second).toBe(spare);
    expect(second.title.value).toBe('bash (2)');
    expect(second.timing?.prewarmed).toBe(true);
    expect(r.m.activeId.value).toBe(spare.id);
    expect(r.host.contains(spare.view.element)).toBe(true);
    await flush(450);
    expect(r.b.spawned).toHaveLength(3); // the next spare
  });

  it('a specific profile / folder / Claude never takes the spare', async () => {
    const r = managerRig();
    r.settings.prewarm = true;
    await r.m.create();
    await flush(450);
    const spare = r.m.spareSession!;
    const z = (await r.m.create({ shellId: 'zsh' }))!;
    expect(z).not.toBe(spare);
    expect(r.m.spareSession).toBe(spare);
  });

  it('the spare goes when the setting is turned off, the default shell changes, the folder changes, or it exits', async () => {
    const r = managerRig();
    r.settings.prewarm = true;
    await r.m.create();
    await flush(450);
    let spare = r.m.spareSession!;
    r.settings.defaultShell = 'zsh';
    r.m.applySettings();
    expect(r.b.kills).toContain(spare.id);
    expect((spare.view as FakeView).disposed).toBe(true);
    expect(r.m.spareSession).toBeNull();

    await r.m.create();
    await flush(450);
    spare = r.m.spareSession!;
    r.b.emitExit(spare.id, 0);
    expect(r.m.spareSession).toBeNull();
    expect((spare.view as FakeView).disposed).toBe(true);

    await r.m.create();
    await flush(450);
    spare = r.m.spareSession!;
    await r.m.closeAll(); // folder switch
    expect(r.b.kills).toContain(spare.id);
    expect(r.m.spareSession).toBeNull();
  });
});

describe('TerminalManager: fast start', () => {
  it('spawns before the view exists (in parallel) and keeps output that arrives meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = managerRig({ createView: async (o) => (await gate, new FakeView(o)) });
    const p = r.m.create();
    await flush();
    expect(r.b.spawned).toHaveLength(1); // the PTY is already starting
    r.b.emitData(1, 'banner\r\nterm$ ');
    release();
    const s = (await p)!;
    expect((s.view as FakeView).written).toBe('banner\r\nterm$ ');
    expect(r.b.acks).toEqual([[1, 14]]);
  });

  it('a shell that exits before its view is ready still ends up as exited (not "running" forever)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = managerRig({ createView: async (o) => (await gate, new FakeView(o)) });
    const p = r.m.create();
    await flush();
    r.b.emitData(1, 'oops');
    r.b.emitExit(1, 2);
    release();
    const s = (await p)!;
    expect(s.status.value).toBe('exited');
    expect((s.view as FakeView).written).toContain('process exited with code 2');
  });

  it('if the view fails after the PTY started, the PTY is killed', async () => {
    const r = managerRig({ createView: async () => Promise.reject(new Error('xterm failed')) });
    expect(await r.m.create()).toBeNull();
    await flush();
    expect(r.b.kills).toEqual([1]);
  });

  it('records the start marks', async () => {
    const r = managerRig();
    const s = (await r.m.create({ t0: performance.now() - 5 }))!;
    r.b.emitData(s.id, 'term$ ');
    await flush(200);
    const T = r.m.timings.at(-1)!;
    for (const k of ['view', 'spawned', 'ready', 'firstOutput', 'prompt'] as const) expect(T[k], k).toBeGreaterThanOrEqual(T.t0);
  });
});
