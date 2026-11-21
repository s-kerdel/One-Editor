// mcp.json parsing, aliases, result limits, client setup snippets, activity lines, settings reading.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aliasFor, limitsFromSettings, parseUndo, parseActivityLine, parseMcpConfig, setupSnippets, tomlString } from '../../../src/shared/mcp';
import { loadSettings, readConfig, visibilityKey } from '../../../src/mcp/config';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';

const tmp = path.resolve(__dirname, '../../../.tmp/mcp/unit', `config-${crypto.randomBytes(4).toString('hex')}`);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('parseMcpConfig', () => {
  it('a missing / broken file is off with no folders (never "everything")', () => {
    for (const raw of [null, undefined, 'x', 42, [], { enabled: 'yes' }]) expect(parseMcpConfig(raw)).toEqual({ version: 1, enabled: false, folders: [], undo: { on: true, days: 30 }, tokens: [] });
  });

  it('keeps valid folders, drops bad ids / aliases / paths and duplicates; only "write" grants writes', () => {
    const c = parseMcpConfig({
      enabled: true,
      folders: [
        { id: 'aaaaaaaa', alias: 'notes', path: '/n', mode: 'write' },
        { id: 'aaaaaaaa', alias: 'dup-id', path: '/d', mode: 'read' },
        { id: 'bbbbbbbb', alias: 'notes', path: '/dup-alias' },
        { id: 'cccccccc', alias: 'Bad Alias', path: '/b' },
        { id: 'dddddddd', alias: 'ok', path: 'bad\u0000path' },
        { id: 'zz', alias: 'short-id', path: '/s' },
        { id: 'eeeeeeee', alias: 'work', path: '/w', mode: 'WRITE' },
        'nope',
      ],
    });
    expect(c.enabled).toBe(true);
    expect(c.folders).toEqual([
      { id: 'aaaaaaaa', alias: 'notes', path: '/n', mode: 'write' },
      { id: 'eeeeeeee', alias: 'work', path: '/w', mode: 'read' },
    ]);
  });

  it('readConfig reads the file; a missing file is off', () => {
    fs.mkdirSync(tmp, { recursive: true });
    const f = path.join(tmp, 'mcp.json');
    expect(readConfig(f).enabled).toBe(false);
    fs.writeFileSync(f, JSON.stringify({ version: 1, enabled: true, folders: [] }));
    expect(readConfig(f).enabled).toBe(true);
    fs.writeFileSync(f, '{ broken');
    expect(readConfig(f).enabled).toBe(false);
  });
});

describe('aliasFor', () => {
  it('makes a lower-case, unique name from a folder name', () => {
    expect(aliasFor('My Notes', [])).toBe('my-notes');
    expect(aliasFor('Café Ünïcode', [])).toBe('cafe-unicode');
    expect(aliasFor('notes', ['notes', 'notes-2'])).toBe('notes-3');
    expect(aliasFor('!!!', [])).toBe('folder');
    expect(aliasFor('.hidden', [])).toBe('hidden');
  });
});

describe('limits', () => {
  it('defaults are small-context friendly; values are clamped', () => {
    expect(limitsFromSettings({})).toEqual({ readChars: 16 * 1024, results: 25 });
    expect(limitsFromSettings({ 'mcp.maxReadKB': 1000, 'mcp.maxResults': 1 })).toEqual({ readChars: 256 * 1024, results: 5 });
    expect(limitsFromSettings({ 'mcp.maxReadKB': 'x', 'mcp.maxResults': null })).toEqual({ readChars: 16 * 1024, results: 25 });
  });

  it('undo copies (mcp.json, main-owned): on by default, 30 days; off only when switched off; days clamped', () => {
    expect(parseUndo(undefined)).toEqual({ on: true, days: 30 });
    expect(parseUndo({ on: false, days: 9999 })).toEqual({ on: false, days: 365 });
    expect(parseUndo({ on: 'no', days: 0 })).toEqual({ on: true, days: 1 });
    expect(parseMcpConfig({ enabled: true, folders: [], undo: { on: false } }).undo).toEqual({ on: false, days: 30 });
  });

  it('code files are a per-folder grant: only allowCode === true', () => {
    const c = parseMcpConfig({ enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'a', path: '/a', mode: 'write', allowCode: true }, { id: 'bbbbbbbb', alias: 'b', path: '/b', mode: 'write', allowCode: 'yes' }] });
    expect(c.folders.map((f) => !!f.allowCode)).toEqual([true, false]);
  });

  it('loadSettings takes only the keys the server uses, and fails closed on a bad file', () => {
    const f = path.join(tmp, 'settings.json');
    fs.mkdirSync(tmp, { recursive: true });
    expect(loadSettings(f)).toMatchObject({ ok: true, settings: { excludeGlobs: DEFAULT_SETTINGS.excludeGlobs } }); // no file: defaults
    fs.writeFileSync(f, JSON.stringify({ excludeGlobs: ['a', 3] }));
    expect(loadSettings(f)).toMatchObject({ ok: false, reason: expect.stringMatching(/excludeGlobs/) });
    fs.writeFileSync(f, '{ "excludeGlobs": ["private"], ');
    expect(loadSettings(f)).toMatchObject({ ok: false, reason: expect.stringMatching(/JSON/) });
    fs.writeFileSync(f, JSON.stringify({ excludeGlobs: ['a'], 'mcp.maxResults': 7, theme: 'light', 'terminal.shell': 'x' }));
    const r = loadSettings(f);
    if (!r.ok) throw new Error(r.reason);
    const s = r.settings;
    expect(s.excludeGlobs).toEqual(['a']);
    expect(s['mcp.maxResults']).toBe(7);
    expect(s['terminal.shell']).toBeUndefined();
    expect(visibilityKey(s)).toBe(visibilityKey({ ...s, 'mcp.maxResults': 9 }));
    expect(visibilityKey(s)).not.toBe(visibilityKey({ ...s, excludeGlobs: ['x'] }));
  });
});

describe('setupSnippets', () => {
  const winLaunch = { command: 'C:\\Apps\\One\\One.exe', args: ['C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\mcp\\cli.mjs', '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } };

  it('LM Studio / Claude Desktop: mcpServers JSON that parses back to the launch', () => {
    const s = setupSnippets(winLaunch, 'win32');
    expect(s.map((x) => x.id)).toEqual(['lmstudio', 'codex', 'claude-desktop', 'claude-code']);
    expect(JSON.parse(s[0].text)).toEqual({ mcpServers: { one: winLaunch } });
    expect(s[0].where).toContain('%USERPROFILE%\\.lmstudio\\mcp.json');
    expect(s[2].where).toContain('%APPDATA%\\Claude\\claude_desktop_config.json');
  });

  it('Codex CLI: [mcp_servers.one] with literal strings (backslashes untouched)', () => {
    const codex = setupSnippets(winLaunch, 'win32')[1].text;
    expect(codex).toBe(
      ["[mcp_servers.one]", "command = 'C:\\Apps\\One\\One.exe'", "args = ['C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\mcp\\cli.mjs', '--stdio']", "env = { ELECTRON_RUN_AS_NODE = '1' }"].join('\n'),
    );
    expect(tomlString("it's")).toBe('"it\'s"');
    expect(tomlString('a"b\\c\'')).toBe('"a\\"b\\\\c\'"');
  });

  it('Claude Code: one command line with quoted paths', () => {
    const lin = setupSnippets({ command: '/opt/One App/one', args: ['/opt/One App/resources/app.asar.unpacked/dist/mcp/cli.mjs', '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } }, 'linux');
    expect(lin[3].text).toBe('claude mcp add --scope user --env ELECTRON_RUN_AS_NODE=1 one -- "/opt/One App/one" "/opt/One App/resources/app.asar.unpacked/dist/mcp/cli.mjs" --stdio');
    expect(lin[0].where).toContain('~/.lmstudio/mcp.json');
  });
});

describe('parseActivityLine', () => {
  it('checks every field of a line another process wrote', () => {
    const ok = parseActivityLine(JSON.stringify({ t: 1, client: 'LM\u0007 Studio', transport: 'stdio', tool: 'read_file', folder: 'notes', path: 'a.md', ok: true, code: null, ms: 3.4, bytes: 10 }));
    expect(ok).toEqual({ t: 1, client: 'LM Studio', transport: 'stdio', tool: 'read_file', folder: 'notes', path: 'a.md', ok: true, code: null, ms: 3, bytes: 10, journal: null, token: null, note: null });
    // A write row's undo group: only a well-formed id survives (main joins it to a folder path).
    expect(parseActivityLine(JSON.stringify({ t: 1, tool: 'write_file', journal: 'mhx1a2b3-0a1b2c3d' }))?.journal).toBe('mhx1a2b3-0a1b2c3d');
    expect(parseActivityLine(JSON.stringify({ t: 1, tool: 'write_file', journal: '../../etc' }))?.journal).toBeNull();
    expect(parseActivityLine('not json')).toBeNull();
    expect(parseActivityLine(JSON.stringify({ t: 'x', tool: 'a' }))).toBeNull();
    expect(parseActivityLine(JSON.stringify({ t: 1, tool: '<img src=x>' }))).toBeNull();
    expect(parseActivityLine(JSON.stringify({ t: 1, tool: 'a', ms: -5, bytes: 'x' }))).toMatchObject({ ms: 0, bytes: 0, client: 'unknown', ok: false });
  });
});
