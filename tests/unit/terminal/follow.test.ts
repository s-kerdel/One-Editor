// "Follow Claude's edits": payload + path rules (pure), the start plans, and the inbox end to end
// (the real hook command run by sh, read back by ClaudeFollow). No Claude session is ever started.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeFollow, FOLLOW_ENV, FOLLOW_HOOK, FOLLOW_MAX_BYTES, FOLLOW_PROMPT_HOOK, followSettings, mapFollowPath, parseFollowEvent, patchLines, readInboxFile } from '../../../src/main/terminal-follow';
import { planClaude } from '../../../src/main/terminal-shells';
import { parseSpawnRequest } from '../../../src/main/terminal';
import { findHint, probeMatches } from '../../../src/renderer/terminal/claude';
import type { TerminalFollowEvent } from '../../../src/shared/terminal';

const post = (tool_name: string, tool_input: unknown, extra: object = {}) => JSON.stringify({ session_id: 's', cwd: '/w', hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: { filePath: 'x' }, ...extra });

describe('hook payloads', () => {
  it('reads Edit / Write / MultiEdit / NotebookEdit and Stop; ignores unknown fields', () => {
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b\n', replace_all: false }, { whatever: { x: 1 } }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'b\n' });
    expect(parseFollowEvent(post('Write', { file_path: 'C:\\w\\a.ts', content: 'secret' }))).toEqual({ kind: 'write', filePath: 'C:\\w\\a.ts' });
    expect(parseFollowEvent(post('MultiEdit', { file_path: '/w/a.ts', edits: [{ new_string: 'one' }, 7, { new_string: 'two' }] }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'two' });
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
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/a' } }),
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
    expect(Object.keys(s.hooks)).toEqual(['PostToolUse', 'Stop', 'UserPromptSubmit']);
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
    expect(events.filter((e) => e.kind === 'edit' || e.kind === 'write')).toEqual([{ id: 7, kind: 'edit', path: 'src/a.ts', hint: 'new text' }]);
    expect(events.filter((e) => e.kind === 'stop')).toEqual([{ id: 7, kind: 'stop' }]);
    expect(events.filter((e) => e.kind === 'prompt')).toEqual([{ id: 7, kind: 'prompt' }]);
    expect(asked.sort()).toEqual(['link-out.txt', 'src/a.ts']); // /etc/passwd never got that far
    await until(() => fs.readdirSync(inbox).every((n) => !/^ev\..*\.json$/.test(n)));
    expect(fs.readdirSync(inbox).sort()).toEqual(['ev.partial', 'other.json']); // read files are deleted, others untouched
    expect(fs.existsSync(path.join(base, 'outside.json'))).toBe(true); // the link went, not its target

    follow.dispose();
    expect(fs.existsSync(s.dir)).toBe(false);
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
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', new_string: 'b' }, { tool_response: { filePath: '/w/a.ts', structuredPatch } }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'b', lines: [[3, 3]], probe: { line: 3, text: 'b' } });
    expect(parseFollowEvent(post('Write', { file_path: '/w/a.ts', content: 'x' }, { tool_response: { type: 'update', structuredPatch } }))).toEqual({ kind: 'write', filePath: '/w/a.ts', lines: [[3, 3]], probe: { line: 3, text: 'b' } });
    expect(parseFollowEvent(post('Write', { file_path: '/w/a.ts', content: 'x' }, { tool_response: { type: 'create', structuredPatch } }))).toEqual({ kind: 'write', filePath: '/w/a.ts' });
    expect(parseFollowEvent(post('Edit', { file_path: '/w/a.ts', new_string: 'b' }, { tool_response: { structuredPatch: [{ newStart: 'x' }] } }))).toEqual({ kind: 'edit', filePath: '/w/a.ts', hint: 'b' });
  });

  it('the probe tells a reloaded document from a stale one', () => {
    expect(probeMatches('  return 1;', { line: 3, text: '  return 1;' })).toBe(true);
    expect(probeMatches('  return 1; // more', { line: 3, text: '  return 1;' })).toBe(false);
    expect(probeMatches('  return 0;', { line: 3, text: '  return 1;' })).toBe(false);
    expect(probeMatches(undefined, { line: 3, text: 'x' })).toBe(false);
    expect(probeMatches('y'.repeat(300), { line: 1, text: 'y'.repeat(200) })).toBe(true); // long lines: by prefix
  });
});
