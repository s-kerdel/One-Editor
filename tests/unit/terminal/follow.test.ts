// "Follow Claude's edits": payload + path rules (pure), the start plans, and the inbox end to end
// (the real hook command run by sh, read back by ClaudeFollow). No Claude session is ever started.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeFollow, FOLLOW_ENV, FOLLOW_HOOK, FOLLOW_MAX_BYTES, FOLLOW_PROMPT_HOOK, FOLLOW_TIMING, followSettings, mapFollowPath, parseFollowEvent, patchCounts, patchLines, readInboxFile } from '../../../src/main/terminal-follow';
import { planClaude } from '../../../src/main/terminal-shells';
import { parseSpawnRequest } from '../../../src/main/terminal';
import { findHint, probeMatches } from '../../../src/renderer/terminal/claude';
import type { TerminalChangesEvent, TerminalFollowEvent } from '../../../src/shared/terminal';

const post = (tool_name: string, tool_input: unknown, extra: object = {}) => JSON.stringify({ session_id: 's', cwd: '/w', hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: { filePath: 'x' }, ...extra });

describe('hook payloads', () => {
  it('reads Edit / Write / MultiEdit / NotebookEdit and Stop; ignores unknown fields', () => {
    // Without a patch in the response the + / − estimate comes from the call's own input (old text against new).
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b\n', replace_all: false }, { whatever: { x: 1 } }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'b\n', counts: { additions: 1, deletions: 1 } });
    expect(parseFollowEvent(post('Write', { file_path: 'C:\\w\\a.ts', content: 'secret' }))).toEqual({ kind: 'write', filePath: 'C:\\w\\a.ts' });
    expect(parseFollowEvent(post('MultiEdit', { file_path: '/w/a.ts', edits: [{ new_string: 'one' }, 7, { new_string: 'two\nthree', old_string: 'x' }] }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'two\nthree', counts: { additions: 3, deletions: 1 } });
    // PreToolUse: "this file is about to change" — the path only, none of the text to come.
    expect(parseFollowEvent(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/w/new.ts', content: 'secret' } }))).toEqual({ kind: 'pre', filePath: '/w/new.ts' });
    expect(parseFollowEvent(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/w/n.ipynb' } }))).toEqual({ kind: 'pre', filePath: '/w/n.ipynb' });
    expect(parseFollowEvent(post('NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: 'x' }))).toEqual({ kind: 'edit', filePath: '/w/n.ipynb' });
    expect(parseFollowEvent(JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'done' }))).toEqual({ kind: 'stop' });
    // The next prompt: only "it happened" — whatever else the payload holds is not carried on.
    expect(parseFollowEvent(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'my secret question', tool_input: { file_path: '/w/a.ts' } }))).toEqual({ kind: 'prompt' });
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', new_string: 'x'.repeat(10000) }))!.hint).toHaveLength(4096);
  });

  it('refuses everything else', () => {
    for (const bad of [
      '',
      'not json',
      '[]',
      'null',
      '"Stop"',
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x', file_path: '/w/a' } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/a\nb' } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: 'x' }),
      JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: '/w/a' } }),
      JSON.stringify({ hook_event_name: 'userpromptsubmit' }),
      JSON.stringify({ hook_event_name: 'UserPromptExpansion', prompt: 'x' }),
      JSON.stringify({ hook_event_name: ['UserPromptSubmit'] }),
      post('Bash', { command: 'rm -rf /', file_path: '/w/a' }),
      post('Read', { file_path: '/w/a' }),
      post('Edit', 'x'),
      post('Edit', { file_path: 7 }),
      post('Edit', { file_path: '' }),
      post('Edit', { file_path: '/w/a\nb' }),
      post('Edit', { file_path: '/w/a\u0000' }),
      post('Edit', { file_path: '/' + 'a'.repeat(5000) }),
      post('Edit', { notebook_path: '/w/a' }),
      post('Edit', { file_path: '/w/a' }, { tool_response: 'Error: failed' }),
    ])
      expect(parseFollowEvent(bad), bad.slice(0, 60)).toBeNull();
  });
});

describe('paths map into the open folder or nowhere', () => {
  const linux = { root: '/home/me/proj', platform: 'linux', foldCase: false };
  const win = { root: 'C:\\Users\\me\\proj', platform: 'win32', foldCase: true };
  const wslUnc = { root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', platform: 'win32', foldCase: false, wslDistro: 'Ubuntu' };
  const wslDrive = { ...win, wslDistro: 'Ubuntu' };

  it('inside', () => {
    expect(mapFollowPath('/home/me/proj/src/a b.ts', linux)).toBe('src/a b.ts');
    expect(mapFollowPath('/home/me/proj/src/../x/./a.ts', linux)).toBe('x/a.ts');
    expect(mapFollowPath('C:\\Users\\me\\proj\\src\\a.ts', win)).toBe('src/a.ts');
    expect(mapFollowPath('c:/users/ME/proj/Src/a.ts', win)).toBe('Src/a.ts'); // the folder's own case rule
    expect(mapFollowPath('/home/me/proj/src/a.ts', wslUnc)).toBe('src/a.ts');
    expect(mapFollowPath('/mnt/c/Users/me/proj/src/a.ts', wslDrive)).toBe('src/a.ts');
    expect(mapFollowPath('D:\\a.ts', { ...win, root: 'D:\\' })).toBe('a.ts');
  });

  it('a folder opened through a link (or /tmp on macOS): Claude names files by the real folder, both names map — nothing else', () => {
    const linked = { root: '/tmp/proj', realRoot: '/private/tmp/proj', platform: 'darwin', foldCase: true };
    expect(mapFollowPath('/private/tmp/proj/src/a.ts', linked)).toBe('src/a.ts');
    expect(mapFollowPath('/tmp/proj/src/a.ts', linked)).toBe('src/a.ts');
    expect(mapFollowPath('/PRIVATE/tmp/Proj/src/a.ts', linked)).toBe('src/a.ts'); // the folder's case rule holds for both
    for (const p of ['/private/tmp/proj', '/private/tmp/project/a', '/private/tmp/proj/../other/a', '/private/tmp/a', '/private/a']) expect(mapFollowPath(p, linked), p).toBeNull();
    expect(mapFollowPath('/private/tmp/proj/a', { ...linked, realRoot: null })).toBeNull();
    // Inside WSL the folder is named by the distro: a host-side real path is not consulted.
    expect(mapFollowPath('/real/a', { root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', realRoot: '/real', platform: 'win32', foldCase: false, wslDistro: 'Ubuntu' })).toBeNull();
  });

  it('outside, relative, odd', () => {
    for (const p of ['/home/me/proj', '/home/me/proj/', '/home/me/proj/../other/a', '/home/me/project/a', '/home/me/Proj/a', '/etc/passwd', 'src/a.ts', '../a', '~/a', 'C:\\Users\\me\\proj\\a']) expect(mapFollowPath(p, linux), p).toBeNull();
    for (const p of ['C:\\Users\\me\\other\\a', 'C:\\Users\\me\\proj\\..\\..\\a', 'D:\\Users\\me\\proj\\a', '\\Users\\me\\proj\\a', 'C:Users\\me\\proj\\a', '/home/me/proj/a', '\\\\nas\\share\\a', 'C:\\Users\\me\\proj\\a.md:stream', 'C:\\Users\\me\\proj']) expect(mapFollowPath(p, win), p).toBeNull();
    for (const p of ['/home/me/Proj/a', '/home/other/a', '/mnt/c/Users/me/proj/a', 'C:\\x']) expect(mapFollowPath(p, wslUnc), p).toBeNull();
    expect(mapFollowPath('/home/me/proj/a', { ...wslUnc, wslDistro: 'Debian' })).toBeNull(); // another distro's folder
    expect(mapFollowPath('/x/a', { root: '\\\\nas\\share', platform: 'win32', foldCase: true, wslDistro: 'Ubuntu' })).toBeNull();
  });
});

describe('start plans', () => {
  const follow = { dir: 'C:\\Users\\R&D $me\\AppData\\Roaming\\One\\claude-follow\\0123', settings: 'C:\\Users\\R&D $me\\AppData\\Roaming\\One\\claude-follow\\0123\\settings.json' };

  it('the hook and the WSL launch script are fixed strings; dynamic values travel as env / argv', () => {
    const s = followSettings();
    expect(s.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(s.hooks.Stop[0].hooks[0].command).toBe(FOLLOW_HOOK);
    expect(Object.keys(s.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
    // The early signal is the same fixed hook on the same tools: it prints nothing and exits 0, so it never decides a call.
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: FOLLOW_HOOK, timeout: 5 }] }]);
    expect(FOLLOW_HOOK).not.toMatch(/Users|home|AppData|\bws\b/);
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: FOLLOW_PROMPT_HOOK, timeout: 5 }] }]);
    expect(JSON.stringify(s)).not.toMatch(/Users|home|AppData/);
    const env = { Path: 'C:\\Windows', WSLENV: 'FOO/u' };
    const wsl = planClaude({ available: true, via: 'wsl', distro: 'Ubuntu', path: '/usr/bin/claude' }, '\\\\wsl.localhost\\Ubuntu\\home\\me\\p', { platform: 'win32', env, wslExe: 'C:\\Windows\\System32\\wsl.exe', follow });
    expect(wsl.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/p', '-e', 'bash', '-lic', 'cd -- "$0" 2>/dev/null; exec claude ${ONE_FOLLOW_DIR:+--settings "$ONE_FOLLOW_DIR/settings.json"}', '/home/me/p']);
    expect(wsl.env).toEqual({ ONE_FOLLOW_DIR: follow.dir, WSLENV: 'FOO/u:ONE_FOLLOW_DIR/p' });
  });

  it('native: --settings as its own argument; cmd shim quoted; Git Bash gets forward slashes', () => {
    expect(planClaude({ available: true, via: 'native', path: '/usr/bin/claude' }, '/p', { platform: 'linux', env: { PATH: '/bin' }, follow: { dir: '/d/x y', settings: '/d/x y/settings.json' } })).toMatchObject({ args: ['--settings', '/d/x y/settings.json'], env: { ONE_FOLLOW_DIR: '/d/x y' } });
    const env = { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const shim = planClaude({ available: true, via: 'native', path: 'C:\\npm\\claude.cmd' }, 'C:\\notes', { platform: 'win32', env, follow });
    expect(shim.args).toBe(`/D /S /C ""C:\\npm\\claude.cmd" --settings "${follow.settings}""`);
    expect(shim.env.ONE_FOLLOW_DIR).toBe('C:/Users/R&D $me/AppData/Roaming/One/claude-follow/0123');
    expect(() => planClaude({ available: true, via: 'native', path: 'C:\\npm\\claude.cmd' }, 'C:\\notes', { platform: 'win32', env, follow: { dir: 'C:\\100%', settings: 'C:\\100%\\settings.json' } })).toThrow(/%/);
  });

  it('the follow flag is a boolean and only counts for Claude', () => {
    expect(parseSpawnRequest({ preset: 'claude', follow: true }).follow).toBe(true);
    expect(parseSpawnRequest({ follow: true }).follow).toBeUndefined();
    expect(parseSpawnRequest({ preset: 'claude', follow: false }).follow).toBeUndefined();
    expect(() => parseSpawnRequest({ preset: 'claude', follow: '/x' })).toThrow();
  });
});

describe('inbox', () => {
  const made: ClaudeFollow[] = [];
  afterEach(() => made.splice(0).forEach((f) => f.dispose()));
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it.skipIf(process.platform === 'win32')('the real hook drops a file; only edits inside the folder reach the window; folders are cleaned up', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "follow it's $HOME "));
    const root = path.join(base, 'ws');
    const events: TerminalFollowEvent[] = [];
    const asked: string[] = [];
    const follow = new ClaudeFollow({ dir: path.join(base, 'data'), inside: async (rel) => (asked.push(rel), rel !== 'link-out.txt'), emit: (_id, e) => events.push(e) });
    made.push(follow);
    const s = (await follow.open(7, { root, platform: 'linux', foldCase: false }))!;
    expect(path.basename(s.dir)).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(s.settings, 'utf8'))).toEqual(followSettings());
    const inbox = path.join(s.dir, 'in');
    const hook = (payload: string, dir = s.dir) => execFileSync('sh', ['-c', FOLLOW_HOOK], { input: payload, env: { PATH: process.env.PATH, [FOLLOW_ENV]: dir } }).toString();

    // Junk another process might leave: a link to a file outside, a non-event name, a huge file, a half-written one.
    fs.writeFileSync(path.join(base, 'outside.json'), post('Edit', { file_path: path.join(root, 'via-link.ts') }));
    fs.symlinkSync(path.join(base, 'outside.json'), path.join(inbox, 'ev.link.json'));
    fs.writeFileSync(path.join(inbox, 'other.json'), post('Edit', { file_path: path.join(root, 'other-name.ts') }));
    fs.writeFileSync(path.join(inbox, 'ev.big.json'), Buffer.alloc(FOLLOW_MAX_BYTES + 1, 0x20));
    fs.writeFileSync(path.join(inbox, 'ev.partial'), post('Edit', { file_path: path.join(root, 'partial.ts') }));
    expect(await readInboxFile(path.join(inbox, 'ev.link.json'))).toBeNull();
    expect(await readInboxFile(path.join(inbox, 'ev.big.json'))).toBeNull();

    expect(hook(post('Edit', { file_path: path.join(root, 'src/a.ts'), new_string: 'new text' }))).toBe('');
    // No inbox (the tab closed): the hook still reads all input, so a big payload never hits a closed pipe.
    expect(hook('x'.repeat(2_000_000), path.join(s.dir, 'gone'))).toBe('');
    hook(post('Write', { file_path: '/etc/passwd', content: 'x' }));
    hook(post('Edit', { file_path: path.join(root, 'link-out.txt'), new_string: 'x' }));
    hook('{"hook_event_name":"Stop"}');
    expect(hook('{"hook_event_name":"Stop"}', path.join(base, 'no such dir'))).toBe(''); // no inbox: silent, exit 0

    // The prompt hook: prints nothing (stdout would reach Claude) and never puts the prompt on disk.
    const quiet = path.join(base, 'quiet');
    fs.mkdirSync(path.join(quiet, 'in'), { recursive: true });
    const sh = (dir: string) => execFileSync('sh', ['-c', FOLLOW_PROMPT_HOOK], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'TOP SECRET '.repeat(50000) }), env: { PATH: process.env.PATH, [FOLLOW_ENV]: dir } }).toString();
    expect(sh(quiet)).toBe('');
    const dropped = fs.readdirSync(path.join(quiet, 'in'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/^ev\.[A-Za-z0-9]{8}\.json$/);
    expect(fs.readFileSync(path.join(quiet, 'in', dropped[0]), 'utf8')).toBe('{"hook_event_name":"UserPromptSubmit"}');
    expect(sh(path.join(base, 'no such dir'))).toBe('');
    sh(s.dir);

    await until(() => events.some((e) => e.kind === 'stop') && events.some((e) => e.kind === 'prompt'));
    expect(events.filter((e) => e.kind === 'edit' || e.kind === 'write')).toEqual([{ id: 7, agent: 'claude', kind: 'edit', path: 'src/a.ts', hint: 'new text' }]);
    expect(events.filter((e) => e.kind === 'stop')).toEqual([{ id: 7, agent: 'claude', kind: 'stop' }]);
    expect(events.filter((e) => e.kind === 'prompt')).toEqual([{ id: 7, agent: 'claude', kind: 'prompt' }]);
    expect(asked.sort()).toEqual(['link-out.txt', 'src/a.ts']); // /etc/passwd never got that far
    await until(() => fs.readdirSync(inbox).every((n) => !/^ev\..*\.json$/.test(n)));
    expect(fs.readdirSync(inbox).sort()).toEqual(['ev.partial', 'other.json']); // read files are deleted, others untouched
    expect(fs.existsSync(path.join(base, 'outside.json'))).toBe(true); // the link went, not its target

    follow.dispose();
    expect(fs.existsSync(s.dir)).toBe(false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** What the hook does, without a shell: the payload under a temporary name, then renamed. */
  const dropper = (dir: string) => {
    let n = 0;
    return (payload: object) => {
      const f = path.join(dir, 'in', `ev.t${String(++n).padStart(6, '0')}`);
      fs.writeFileSync(f, JSON.stringify(payload));
      fs.renameSync(f, f + '.json');
    };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const patchOf = (...lines: string[]) => ({ structuredPatch: [{ newStart: 1, lines }] });
  const tool = (event: string, name: string, file: string, extra: object = {}) => ({ hook_event_name: event, tool_name: name, tool_input: { file_path: file }, ...extra });

  it.skipIf(process.platform === 'win32')('the change list: a row before the write, an estimate after it, git\'s numbers at Stop — and only what the session changed', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-list-'));
    const root = path.join(base, 'ws');
    const lists: TerminalChangesEvent[] = [];
    const last = () => lists.at(-1);
    // What git says. At the start: old.md was already uncommitted (the user's own work, before Claude did anything).
    let git: unknown = [{ path: 'old.md', additions: 9, deletions: 9, status: 'modified' }];
    let asked = 0;
    const follow = new ClaudeFollow({ dir: path.join(base, 'data'), inside: async (rel) => rel !== 'link-out.ts', emit: () => {}, emitChanges: (_id, e) => lists.push(e), numstat: async () => (asked++, git) });
    made.push(follow);
    const s = (await follow.open(3, { root, platform: 'linux', foldCase: false }))!;
    const drop = dropper(s.dir);
    await until(() => asked === 1); // the baseline, once

    drop({ hook_event_name: 'UserPromptSubmit' });
    await until(() => last()?.busy === true);
    expect(last()).toEqual({ id: 3, agent: 'claude', busy: true, turns: 1, files: [] });

    // PreToolUse: the row is there before the file changes. Outside the folder / through a link out: never a row.
    drop(tool('PreToolUse', 'Edit', path.join(root, 'src/a.ts')));
    drop(tool('PreToolUse', 'Write', '/etc/passwd'));
    drop(tool('PreToolUse', 'Write', path.join(root, 'link-out.ts')));
    await until(() => last()?.files.length === 1);
    expect(last()!.files).toEqual([{ path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, turn: 1, exact: false }]);

    // A call the user refused: announced, never written.
    drop(tool('PreToolUse', 'Write', path.join(root, 'refused.ts')));
    await until(() => last()?.files.length === 2);
    // PostToolUse: this edit's + / − from its patch, twice on the same file: summed, still an estimate.
    drop(tool('PostToolUse', 'Edit', path.join(root, 'src/a.ts'), { tool_response: patchOf(' ctx', '-old', '+new 1', '+new 2') }));
    await until(() => last()?.files.find((f) => f.path === 'src/a.ts')?.additions === 2);
    drop(tool('PostToolUse', 'Edit', path.join(root, 'src/a.ts'), { tool_response: patchOf('+more') }));
    drop(tool('PostToolUse', 'Write', path.join(root, 'new.ts'), { tool_input: { file_path: path.join(root, 'new.ts'), content: 'a\nb\nc\n' }, tool_response: { type: 'create' } }));
    await until(() => last()?.files.length === 3 && last()!.files.find((f) => f.path === 'src/a.ts')?.additions === 3);
    expect(last()!.files).toEqual([
      { path: 'new.ts', status: 'added', additions: 3, deletions: 0, turn: 1, exact: false },
      { path: 'refused.ts', status: 'modified', additions: 0, deletions: 0, turn: 1, exact: false },
      { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, turn: 1, exact: false },
    ]);

    // Stop: git counts. a.ts gets its numbers; a file only a shell command changed joins; old.md is as it was before
    // the session → not Claude's; the refused call's row goes; paths that are not inside the folder are dropped.
    git = [
      { path: 'src/a.ts', additions: 2, deletions: 1, status: 'modified' },
      { path: 'old.md', additions: 9, deletions: 9, status: 'modified' },
      { path: 'made-by-shell.txt', additions: 4, deletions: 0, status: 'added' },
      { path: '../outside.txt', additions: 1, deletions: 0, status: 'added' },
      { path: '/etc/passwd', additions: 1, deletions: 0, status: 'modified' },
      { path: 'odd.txt', additions: -1, deletions: 0, status: 'modified' },
    ];
    drop({ hook_event_name: 'Stop' });
    await until(() => last()?.busy === false && !!last()?.files.some((f) => f.path === 'made-by-shell.txt'));
    expect(last()).toEqual({
      id: 3,
      agent: 'claude',
      busy: false,
      turns: 1,
      files: [
        { path: 'made-by-shell.txt', status: 'added', additions: 4, deletions: 0, turn: 1, exact: true },
        { path: 'new.ts', status: 'added', additions: 3, deletions: 0, turn: 1, exact: false }, // untracked: git has no numbers for it
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, turn: 1, exact: true },
      ],
    });

    // The next turn: an edit moves its file to that turn; what git no longer lists (the shell's file was removed) goes,
    // what Claude itself named stays (committed or not).
    drop({ hook_event_name: 'UserPromptSubmit' });
    await until(() => last()?.turns === 2);
    drop(tool('PostToolUse', 'Edit', path.join(root, 'new.ts'), { tool_response: patchOf('+d') }));
    await until(() => last()?.files.find((f) => f.path === 'new.ts')?.turn === 2);
    git = [{ path: 'old.md', additions: 9, deletions: 9, status: 'modified' }];
    drop({ hook_event_name: 'Stop' });
    await until(() => last()?.busy === false && last()!.files.length === 2);
    expect(last()!.files).toEqual([
      { path: 'new.ts', status: 'added', additions: 4, deletions: 0, turn: 2, exact: false },
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, turn: 1, exact: true },
    ]);
    expect(asked).toBe(5); // a snapshot at the start and at each prompt + one per Stop: nothing polls git

    // No git (not a repository, not trusted): the estimates simply stay.
    git = null;
    drop({ hook_event_name: 'UserPromptSubmit' });
    drop(tool('PostToolUse', 'Edit', path.join(root, 'src/a.ts'), { tool_response: patchOf('+x', '+y') }));
    await until(() => last()?.files.find((f) => f.path === 'src/a.ts')?.turn === 3);
    drop({ hook_event_name: 'Stop' });
    await until(() => last()?.busy === false && last()!.turns === 3);
    expect(last()!.files.find((f) => f.path === 'src/a.ts')).toEqual({ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1, turn: 3, exact: false });
    follow.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('a snapshot per prompt: the user’s save before prompt 2 is not in its list; Claude’s change in prompt 2 is', async () => {
    const tmp = path.resolve(__dirname, '../../../.tmp/terminal');
    fs.mkdirSync(tmp, { recursive: true });
    const base = fs.mkdtempSync(path.join(tmp, 'follow-turns-'));
    const root = path.join(base, 'ws');
    const lists: TerminalChangesEvent[] = [];
    const last = () => lists.at(-1);
    const n = (p: string, additions: number, status = 'modified') => ({ path: p, additions, deletions: 0, status });
    let git: unknown = [];
    let asked = 0;
    let slow: Promise<void> | null = null; // a git answer that takes its time
    const numstat = async () => {
      asked++;
      const now = git; // git's answer is about the moment it was asked
      await slow;
      return now;
    };
    const follow = new ClaudeFollow({ dir: path.join(base, 'data'), inside: async () => true, emit: () => {}, emitChanges: (_id, e) => lists.push(e), numstat });
    made.push(follow);
    const s = (await follow.open(4, { root, platform: 'linux', foldCase: false }))!;
    const drop = dropper(s.dir);
    await until(() => asked === 1);

    drop({ hook_event_name: 'UserPromptSubmit' });
    await until(() => asked === 2);
    drop(tool('PostToolUse', 'Edit', path.join(root, 'a.ts'), { tool_response: patchOf('+a') }));
    await until(() => last()?.files.length === 1);
    git = [n('a.ts', 1)];
    drop({ hook_event_name: 'Stop' });
    await until(() => last()?.busy === false && !!last()?.files[0]?.exact);

    // Between the turns: the user saves notes.md in the editor.
    git = [n('a.ts', 1), n('notes.md', 2)];
    // Prompt 2, and a git that answers late: the Stop must still wait for the turn's own snapshot.
    let release!: () => void;
    slow = new Promise<void>((r) => (release = r));
    drop({ hook_event_name: 'UserPromptSubmit' });
    await until(() => asked === 4);
    drop(tool('PostToolUse', 'Edit', path.join(root, 'b.ts'), { tool_response: patchOf('+b', '+c') }));
    await until(() => last()?.files.length === 2);
    const turn2 = [n('a.ts', 1), n('notes.md', 2), n('b.ts', 2), n('made-by-shell.txt', 3, 'added')];
    drop({ hook_event_name: 'Stop' });
    await sleep(100);
    git = turn2; // what the Stop's own numstat sees (the snapshot was asked for before)
    slow = null;
    release();
    await until(() => last()?.busy === false && last()!.files.length === 3);
    expect(last()!.files).toEqual([
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, turn: 1, exact: true },
      { path: 'b.ts', status: 'modified', additions: 2, deletions: 0, turn: 2, exact: true },
      { path: 'made-by-shell.txt', status: 'added', additions: 3, deletions: 0, turn: 2, exact: true },
    ]);
    follow.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('latency: tens of ms with change events; without them 250 ms while a turn runs, one read every 2 s when idle', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-poll-'));
    const ctx = { root: path.join(base, 'ws'), platform: 'linux', foldCase: false };
    let seenAt = 0; // when the newest event reached the window (the wait below only looks every 50 ms)
    const rig = async (o: object) => {
      const events: TerminalFollowEvent[] = [];
      const f = new ClaudeFollow({ dir: path.join(base, 'data'), inside: async () => true, emit: (_id, e) => ((seenAt = performance.now()), events.push(e)), ...o });
      made.push(f);
      const s = (await f.open(1, ctx))!;
      return { f, events, drop: dropper(s.dir) };
    };
    const timed = async (events: TerminalFollowEvent[], go: () => void) => {
      const n = events.length;
      const t0 = performance.now();
      go();
      await until(() => events.length > n);
      return seenAt - t0;
    };
    const edit = tool('PostToolUse', 'Edit', path.join(ctx.root, 'a.ts'));

    // 1. Change events, the normal path: the scan runs 10 ms after the event (it was 60 ms).
    const a = await rig({});
    await timed(a.events, () => a.drop({ hook_event_name: 'UserPromptSubmit' }));
    const watched = Math.max(await timed(a.events, () => a.drop(edit)), await timed(a.events, () => a.drop(edit)));
    expect(watched).toBeLessThan(250); // measured: ~20 ms (it was 60 ms + the read)

    // 2. No change events at all (a file system without them): the poll alone. While a turn runs it comes every
    // 250 ms — four edits in a row each arrive well inside the old 2 s poll's wait.
    const b = await rig({ watch: false });
    await timed(b.events, () => b.drop({ hook_event_name: 'UserPromptSubmit' }));
    let polled = 0;
    for (let i = 0; i < 4; i++) polled = Math.max(polled, await timed(b.events, () => b.drop(edit)));
    expect(polled).toBeLessThan(FOLLOW_TIMING.fastPollMs * 3); // measured: ≤ 260 ms
    expect(FOLLOW_TIMING).toMatchObject({ debounceMs: 10, fastPollMs: 250, idlePollMs: 2000 });

    // 3. What it costs (same rules, 1 / 5 of the times): a working session is read every tick, an idle one rarely.
    const c = await rig({ watch: false, timing: { fastPollMs: 50, idlePollMs: 400, hotTailMs: 100 } });
    await timed(c.events, () => c.drop({ hook_event_name: 'UserPromptSubmit' }));
    let from = c.f.stats().scans;
    await sleep(500);
    const working = c.f.stats().scans - from;
    await timed(c.events, () => c.drop({ hook_event_name: 'Stop' }));
    await sleep(150); // the tail after the last event
    from = c.f.stats().scans;
    await sleep(800);
    const idle = c.f.stats().scans - from;
    expect(working).toBeGreaterThanOrEqual(5); // ~10
    expect(idle).toBeLessThanOrEqual(3); // ~2
    console.info(`[follow latency] change events: ${watched.toFixed(0)} ms, poll only while working: ${polled.toFixed(0)} ms; inbox reads in 500 ms working: ${working}, in 800 ms idle: ${idle}`);
    [a, b, c].forEach((x) => x.f.dispose());
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('a flood is read at 80 files a second at most, 40 a scan', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-flood-'));
    const root = path.join(base, 'ws');
    const events: TerminalFollowEvent[] = [];
    const follow = new ClaudeFollow({ dir: path.join(base, 'data'), inside: async () => true, emit: (_id, e) => events.push(e), timing: { floodWaitMs: 200 } });
    made.push(follow);
    const s = (await follow.open(1, { root, platform: 'linux', foldCase: false }))!;
    const drop = dropper(s.dir);
    for (let i = 0; i < 100; i++) drop(tool('PostToolUse', 'Edit', path.join(root, `f${i}.ts`)));
    await sleep(700);
    expect(events.length).toBeLessThanOrEqual(80);
    expect(events.length).toBeGreaterThanOrEqual(40);
    await until(() => events.length === 100);
    expect(new Set(events.map((e) => e.path)).size).toBe(100); // late, never lost
    follow.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('finding the edited lines', () => {
  it('locates the new text in the LF document', () => {
    expect(findHint('a\nfoo\nbar\nb', 'foo\r\nbar\r\n')).toEqual({ from: 2, to: 9, unique: true });
    // A common line (a closing brace, `return null;`) is found, but is not proof of the place.
    expect(findHint('}\nx\n}\n', '}')).toEqual({ from: 0, to: 1, unique: false });
    expect(findHint('if (a) {\n  return null;\n}\nreturn null;\n', 'return null;')).toMatchObject({ from: 11, unique: false });
    expect(findHint('a\nb', 'zzz')).toBeNull();
    expect(findHint('a\nb', '  \n')).toBeNull();
    expect(findHint('a\nb', undefined)).toBeNull();
  });
});

describe("exact lines from Claude's patch", () => {
  const hunk = (newStart: number, lines: string[]) => ({ oldStart: newStart, oldLines: 0, newStart, newLines: 0, lines });
  const of = (...hunks: unknown[]) => patchLines({ filePath: '/w/a', structuredPatch: hunks });

  it('marks added lines, not the context around them', () => {
    expect(of(hunk(10, [' a', ' b', ' c', '+new one', '+new two', ' d', ' e', ' f']))).toEqual({ lines: [[13, 14]], probe: { line: 13, text: 'new one' } });
    expect(of(hunk(1, ['+first']))).toEqual({ lines: [[1, 1]], probe: { line: 1, text: 'first' } });
  });

  it('a replacement marks the new lines; a pure deletion marks where it happened (no probe)', () => {
    expect(of(hunk(5, [' a', '-old 1', '-old 2', '+new', ' b']))).toEqual({ lines: [[6, 6]], probe: { line: 6, text: 'new' } });
    expect(of(hunk(5, [' a', '-gone', '-gone too', ' b']))).toEqual({ lines: [[6, 6]] });
    expect(of(hunk(0, ['-only line']))).toEqual({ lines: [[1, 1]] }); // the file was emptied
  });

  it('mixed hunks and several hunks: one merged, sorted list; the probe is the first non-blank added line', () => {
    expect(of(hunk(3, [' a', '+x', ' b', ' c', '-y', '+z', '+', '\\ No newline at end of file']), hunk(40, ['+', '+tail\r']))).toEqual({ lines: [[4, 4], [7, 8], [40, 41]], probe: { line: 4, text: 'x' } });
    expect(of(hunk(40, ['+b']), hunk(2, ['+', '+a']))).toEqual({ lines: [[2, 3], [40, 40]], probe: { line: 40, text: 'b' } });
    expect(of(hunk(1, ['+' + 'x'.repeat(500)]))!.probe!.text).toHaveLength(200);
    const many = Array.from({ length: 30 }, (_, i) => hunk(i * 10 + 1, ['+l']));
    expect(of(...many)!.lines).toHaveLength(20); // capped
  });

  it('garbage is no patch at all', () => {
    for (const bad of [null, 'x', [], {}, { structuredPatch: 'x' }, { structuredPatch: [] }, { structuredPatch: [7] }, { structuredPatch: [{ newStart: 1 }] }, { structuredPatch: [{ newStart: '1', lines: ['+a'] }] }, { structuredPatch: [{ newStart: 1.5, lines: ['+a'] }] }, { structuredPatch: [{ newStart: -1, lines: ['+a'] }] }, { structuredPatch: [{ newStart: 1e12, lines: ['+a'] }] }, { structuredPatch: [{ newStart: 1, lines: ['+a', 7] }] }, { structuredPatch: [{ newStart: 1, lines: ['@@ -1 +1 @@'] }] }, { structuredPatch: [{ newStart: 1, lines: [' only context'] }] }, { structuredPatch: Array.from({ length: 201 }, () => hunk(1, ['+a'])) }])
      expect(patchLines(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
  });

  it('travels with the event; a created file and a bad patch fall back', () => {
    const structuredPatch = [hunk(2, [' a', '+b'])];
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', new_string: 'b' }, { tool_response: { filePath: '/w/a.ts', structuredPatch } }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'b', lines: [[3, 3]], probe: { line: 3, text: 'b' }, counts: { additions: 1, deletions: 0 } });
    expect(parseFollowEvent(post('Write', { file_path: '/w/a.ts', content: 'x' }, { tool_response: { type: 'update', structuredPatch } }))).toEqual({ kind: 'write', filePath: '/w/a.ts', lines: [[3, 3]], probe: { line: 3, text: 'b' }, counts: { additions: 1, deletions: 0 } });
    // A new file: all of its lines are added (counted from the text written), there is no patch to walk.
    expect(parseFollowEvent(post('Write', { file_path: '/w/a.ts', content: 'x\ny\n' }, { tool_response: { type: 'create', structuredPatch } }))).toEqual({ kind: 'write', filePath: '/w/a.ts', created: true, counts: { additions: 2, deletions: 0 } });
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', new_string: 'b' }, { tool_response: { structuredPatch: [{ newStart: 'x' }] } }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'b', counts: { additions: 1, deletions: 0 } });
  });

  it('counts the added and removed lines of the same patch (the change list\'s estimate)', () => {
    expect(patchCounts({ structuredPatch: [hunk(5, [' a', '-old 1', '-old 2', '+new', ' b', '\\ No newline at end of file']), hunk(40, ['+x', '+y'])] })).toEqual({ additions: 3, deletions: 2 });
    expect(patchCounts({ structuredPatch: [hunk(1, [' only context'])] })).toBeNull();
    expect(patchCounts({ structuredPatch: [{ newStart: 'x', lines: ['+a'] }] })).toBeNull();
    expect(patchCounts(null)).toBeNull();
  });

  it('the probe tells a reloaded document from a stale one', () => {
    expect(probeMatches('  return 1;', { line: 3, text: '  return 1;' })).toBe(true);
    expect(probeMatches('  return 1; // more', { line: 3, text: '  return 1;' })).toBe(false);
    expect(probeMatches('  return 0;', { line: 3, text: '  return 1;' })).toBe(false);
    expect(probeMatches(undefined, { line: 3, text: 'x' })).toBe(false);
    expect(probeMatches('y'.repeat(300), { line: 1, text: 'y'.repeat(200) })).toBe(true); // long lines: by prefix
  });
});
