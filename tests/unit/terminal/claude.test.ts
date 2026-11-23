// @vitest-environment happy-dom
// "Ask Claude": prompt text + pre-filling it into a (reused or new) Claude Code terminal, never pressing Enter.
import { describe, it, expect, beforeEach } from 'vitest';
import { claudePrompt, oneLine, QUOTE_LIMIT } from '../../../src/renderer/terminal/claude';
import { launcherRows } from '../../../src/renderer/terminal/Panel';
import { FakeView, flush, managerRig } from './fakes';

beforeEach(() => {
  FakeView.all = [];
  document.body.innerHTML = '';
});

describe('claudePrompt', () => {
  it('file → an @ mention Claude Code resolves itself', () => {
    expect(claudePrompt({ path: 'notes/a.md' })).toBe('@notes/a.md ');
  });
  it('selection → line range + the text when short', () => {
    expect(claudePrompt({ path: 'src/a.ts', startLine: 12, endLine: 12, text: '  const x = 1;  ' })).toBe('@src/a.ts line 12: "const x = 1;" ');
    expect(claudePrompt({ path: 'src/a.ts', startLine: 12, endLine: 14, text: 'a\nb\nc\n' })).toBe('@src/a.ts lines 12-14:\n```\na\nb\nc\n```\n');
    expect(claudePrompt({ path: 'a.md', startLine: 1, endLine: 2, text: '```js\nx\n```' })).toBe('@a.md lines 1-2:\n~~~~\n```js\nx\n```\n~~~~\n');
    expect(claudePrompt({ path: 'src/a.ts', startLine: 12, endLine: 30, text: 'x'.repeat(QUOTE_LIMIT + 1) })).toBe('@src/a.ts lines 12-30 ');
  });
  it('paths with spaces are quoted; control characters never reach the TUI', () => {
    expect(claudePrompt({ path: 'my notes/a b.md' })).toBe('"my notes/a b.md" ');
    expect(claudePrompt({ path: 'a.md', startLine: 3, text: 'rm\u001b[201~\u0003x' })).toBe('@a.md line 3: "rm[201~x" ');
  });
  it('oneLine joins lines (a TUI without bracketed paste would submit at each newline)', () => {
    expect(oneLine('@a.md lines 1-2:\n```\nx\n```\n')).toBe('@a.md lines 1-2: ``` x ``` ');
  });
});

describe('follow edits: one setting per agent', () => {
  const flags = async (set: { followClaude?: boolean; followOpencode?: boolean }) => {
    const r = managerRig();
    Object.assign(r.settings, set);
    await r.m.create({ preset: 'claude' });
    await r.m.create({ preset: 'opencode' });
    await r.m.create();
    return r.b.spawned.map((q) => [q.preset ?? 'shell', q.follow ?? false]);
  };
  it('both off by default: each agent starts as in any terminal', async () => {
    expect(await flags({})).toEqual([['claude', false], ['opencode', false], ['shell', false]]);
  });
  it('each toggle turns on its own agent only', async () => {
    expect(await flags({ followClaude: true })).toEqual([['claude', true], ['opencode', false], ['shell', false]]);
    expect(await flags({ followOpencode: true })).toEqual([['claude', false], ['opencode', true], ['shell', false]]);
    expect(await flags({ followClaude: true, followOpencode: true })).toEqual([['claude', true], ['opencode', true], ['shell', false]]);
  });
  it('a restart keeps the agent and reads its setting again; the launcher keeps both tiles across a shell-list reload', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list, claude: { available: true, via: 'native', path: '/usr/bin/claude' }, opencode: { available: true, path: '/usr/bin/opencode' } };
    await r.m.ensureClaude();
    const s = (await r.m.create({ preset: 'opencode' }))!;
    expect(s.shell).toMatchObject({ kind: 'opencode', name: 'Opencode' });
    r.settings.followOpencode = true;
    await r.m.restart(s.id);
    expect(r.b.spawned.map((q) => [q.preset, q.follow ?? false])).toEqual([['opencode', false], ['opencode', true]]);
    // A plain shell-list load (no agent lookup) after the default shell changed must not drop what the deeper lookup found.
    r.b.list = { ...r.b.list, claude: undefined, opencode: undefined };
    r.settings.defaultShell = 'zsh';
    await r.m.loadShells();
    expect(r.m.shells.value).toMatchObject({ claude: { available: true }, opencode: { available: true } });
  });
});

describe('TerminalManager.askClaude', () => {
  it('starts Claude Code once, waits for it, pre-fills — no Enter; then reuses the same terminal', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list, claude: { available: true, via: 'native', path: '/usr/bin/claude' } };
    const p = r.m.askClaude('@notes/a.md ');
    await flush(20);
    expect(r.b.spawned).toEqual([{ shellId: undefined, prefer: undefined, cwd: undefined, cols: 80, rows: 24, preset: 'claude' }]); // follow is off by default
    r.b.emitData(1, '╭ Claude Code ╮');
    expect(await p).toBe(true);
    const v = FakeView.all[0];
    expect(v.pasted).toEqual(['@notes/a.md ']);
    expect(await r.m.askClaude('@src/b.ts line 3 ')).toBe(true);
    expect(r.b.spawned).toHaveLength(1); // reused
    expect(v.pasted).toEqual(['@notes/a.md ', '@src/b.ts line 3 ']);
    expect(r.b.writes.some(([, d]) => d.includes('\r'))).toBe(false); // never pressed Enter
  });

  it('without bracketed paste the prompt is pasted as one line', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list, claude: { available: true, via: 'native', path: '/usr/bin/claude' } };
    const s = (await r.m.create({ preset: 'claude' }))!;
    FakeView.all[0].bracketedPaste = false;
    await r.m.askClaude('@a.md lines 1-2:\n```\nx\n```\n');
    expect(FakeView.all[0].pasted).toEqual(['@a.md lines 1-2: ``` x ``` ']);
    expect(r.b.writes).toEqual([[s.id, '@a.md lines 1-2: ``` x ``` ']]);
  });

  it('not installed → the install hint, no terminal', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list, claude: { available: false, hint: 'Claude Code is not installed. In a terminal: curl …' } };
    expect(await r.m.askClaude('@a.md ')).toBe(false);
    expect(r.toasts).toEqual(['Claude Code is not installed. In a terminal: curl …']);
    expect(r.b.spawned).toEqual([]);
  });

  it('launcher rows: "Claude Code" when found (in WSL: says where), else the install command', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list, claude: { available: true, via: 'wsl', distro: 'Ubuntu', path: '/home/me/.local/bin/claude' } };
    await r.m.loadShells();
    const rows = launcherRows(r.m);
    expect(rows.map((i) => i.name)).toEqual(['bash', 'zsh', 'Command Prompt', 'Claude Code']);
    expect(rows[3]).toMatchObject({ kind: 'claude', detail: 'AI assistant · in Ubuntu (WSL)', canDefault: false, isDefault: false });
    rows[3].launch();
    await flush();
    expect(r.b.spawned.at(-1)).toMatchObject({ preset: 'claude' });

    const r2 = managerRig();
    r2.b.list = { ...r2.b.list, claude: { available: false, hint: 'install hint', install: 'curl -fsSL https://claude.ai/install.sh | bash' } };
    await r2.m.loadShells();
    const toasts: string[] = [];
    const missing = launcherRows(r2.m, { toast: (m) => toasts.push(m) }).find((i) => i.kind === 'claude')!;
    expect(missing).toMatchObject({ name: 'Claude Code', detail: 'Not installed', missing: true, install: 'curl -fsSL https://claude.ai/install.sh | bash' });
    missing.launch();
    expect(toasts).toEqual(['install hint']);
    expect(r2.b.spawned).toEqual([]);
  });

  it('the default-shell setting is passed along (Claude is looked up inside a preferred WSL distro)', async () => {
    const r = managerRig();
    const seen: Array<string | undefined> = [];
    const orig = r.b.listShells.bind(r.b);
    r.b.listShells = async (refresh?: boolean, prefer?: string) => (seen.push(prefer), orig());
    await r.m.loadShells();
    r.settings.defaultShell = 'wsl:Ubuntu';
    await r.m.loadShells(); // setting changed → re-asked
    await r.m.loadShells();
    expect(seen).toEqual([undefined, 'wsl:Ubuntu']);
  });

  it('starting Claude passes the ★ default shell along, so a native default (pwsh) is not overruled by the folder\'s WSL default', async () => {
    const r = managerRig();
    r.b.list = { ...r.b.list, claude: { available: true, via: 'native', path: 'C:/Users/me/.local/bin/claude.exe' } };
    r.settings.defaultShell = 'pwsh';
    void r.m.askClaude('@a.md ');
    await flush(20);
    expect(r.b.spawned[0]).toMatchObject({ preset: 'claude', prefer: 'pwsh', shellId: undefined });
  });
});
