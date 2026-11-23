// The user's file type associations (settings.json `files.associations`) and MCP writes: a mapping can only
// make the file type rule STRICTER — a file opened as PHP is code like a .php file — and never makes a name
// writable. settings.json is written by the page; it is not a grant (those are mcp.json, behind native dialogs).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { OneMcpServer } from '../../../src/mcp/server';
import { writeTypeProblem } from '../../../src/mcp/folders';
import { loadSettings } from '../../../src/mcp/config';
import { associationMatcher, LANGUAGES } from '../../../src/shared/languages';
import type { McpConfig } from '../../../src/shared/mcp';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const servers: OneMcpServer[] = [];
beforeAll(() => {
  tmp = path.join(BASE, `filetypes-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const s of servers) await s.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function make(root: string, settings: Partial<Settings>) {
  let s: Settings = { ...DEFAULT_SETTINGS, ...settings } as Settings;
  const server = new OneMcpServer({ configDir: path.join(tmp, 'cfg'), settings: s, transport: 'stdio', win: false, idleMs: 60_000, indexWaitMs: 8000 });
  servers.push(server);
  const cfg: McpConfig = { version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode: 'write' }] };
  server.applyConfig(cfg);
  let id = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) => server.protocol.handle({ jsonrpc: '2.0', id: id++, method, params }) as Promise<any>;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'file-types' } });
  const write = async (p: string) => {
    const r = await rpc('tools/call', { name: 'write_file', arguments: { path: p, content: 'x\n' } });
    return { isError: !!r.result?.isError || !!r.error, text: (r.result?.content?.[0]?.text as string) ?? '' };
  };
  return {
    write,
    setCode: (allowCode: boolean) => server.applyConfig({ ...cfg, folders: [{ ...cfg.folders[0], allowCode }] }),
    setSettings: (p: Partial<Settings>) => server.applySettings((s = { ...s, ...p } as Settings)),
  };
}

const ALL = ['a.md', 'b.markdown', 'c.txt', 'd.php', 'e.ts', 'f.json', 'g.ctp', 'h.js', 'i.py', 'j.ps1', 'k.bat', 'l.sh', 'm.exe', 'n.lnk', 'desktop.ini', 'Jenkinsfile', 'noext', 'p.inc', 'q.tpl', 'dockerfile.dev', '.env'];

describe('writeTypeProblem with the user’s associations', () => {
  it('never allows what the name alone refuses (every language, with and without the code grant)', () => {
    for (const lang of LANGUAGES) {
      const mapped = associationMatcher(Object.fromEntries([...ALL.map((n) => [n.toLowerCase(), lang.id]), ['*.ctp', lang.id], ['*.txt', lang.id], ['*.js', lang.id], ['*.exe', lang.id], ['*.tpl', lang.id]]));
      for (const allowCode of [false, true]) {
        for (const name of ALL) {
          const plain = writeTypeProblem(name, allowCode);
          const withMap = writeTypeProblem(name, allowCode, mapped);
          if (plain !== null) expect(withMap, `${name} → ${lang.id} (code: ${allowCode})`).not.toBeNull();
        }
      }
    }
  });

  it('a file opened as code is held to the code rule; as a never-written language it is never written', () => {
    const m = associationMatcher({ '*.txt': 'php', '*.ctp': 'php', '*.task': 'javascript', 'run.txt': 'python', '*.cfg': 'powershell', '*.note': 'markdown', '*.log': 'text', 'build.txt': 'bat' });
    // .txt is a note type, but the user opens it as PHP: it needs the code grant, like a .php file.
    expect(writeTypeProblem('notes.txt', false)).toBeNull();
    expect(writeTypeProblem('notes.txt', false, m)).toMatch(/only notes/);
    expect(writeTypeProblem('notes.txt', true, m)).toBeNull();
    expect(writeTypeProblem('NOTES.TXT', false, m)).toMatch(/only notes/);
    // Mapped to a language whose own files are never written: never, whatever the grant.
    for (const p of ['run.txt', 'x.task', 'x.cfg', 'build.txt']) for (const code of [false, true]) expect(writeTypeProblem(p, code, m), p).toMatch(/never written/);
    // A mapping gives nothing: *.ctp stays unwritable even with the code grant (no text file extension).
    expect(writeTypeProblem('view.ctp', false, m)).toMatch(/only notes/);
    expect(writeTypeProblem('view.ctp', true, m)).toMatch(/no text file extension/);
    expect(writeTypeProblem('view.ctp', true)).toMatch(/no text file extension/);
    // Markdown / plain text mappings and unmapped names: exactly the rule without a map.
    for (const p of ['a.md', 'b.log', 'c.note', 'd.php', 'e.js', 'f.json']) for (const code of [false, true]) expect(writeTypeProblem(p, code, m), p).toBe(writeTypeProblem(p, code));
    // Notes cannot be re-mapped at all.
    expect(writeTypeProblem('a.md', false, associationMatcher({ '*.md': 'javascript', 'a.*': 'javascript' }))).toBeNull();
  });
});

describe('MCP write tools follow it', () => {
  it('write_file: stricter with a mapping, back to normal without it', async () => {
    const root = path.join(tmp, 'ws');
    fs.mkdirSync(root, { recursive: true });
    const t = await make(root, {});
    expect((await t.write('plain.txt')).isError).toBe(false);

    t.setSettings({ 'files.associations': { '*.txt': 'php', '*.ctp': 'php', 'todo.txt': 'javascript' } });
    const refused = await t.write('page.txt');
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/only notes/);
    expect(fs.existsSync(path.join(root, 'page.txt'))).toBe(false);
    expect((await t.write('todo.txt')).text).toMatch(/never written/);
    expect((await t.write('note.md')).isError).toBe(false);

    t.setCode(true);
    expect((await t.write('page.txt')).isError).toBe(false);
    expect((await t.write('todo.txt')).text).toMatch(/never written/);
    expect((await t.write('view.ctp')).text).toMatch(/no text file extension/);
    expect(fs.existsSync(path.join(root, 'view.ctp'))).toBe(false);

    t.setCode(false);
    t.setSettings({ 'files.associations': null });
    expect((await t.write('todo.txt')).isError).toBe(false);
  });

  it('the server reads the key from settings.json (and nothing else new)', () => {
    const file = path.join(tmp, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ 'files.associations': { '*.txt': 'php' }, theme: 'light', 'terminal.shell': 'x' }));
    const r = loadSettings(file);
    expect(r.ok && r.settings['files.associations']).toEqual({ '*.txt': 'php' });
    expect(r.ok && r.settings['terminal.shell']).toBeUndefined();
    // Junk in the key cannot stop the server or widen anything: it is just no mapping.
    fs.writeFileSync(file, JSON.stringify({ 'files.associations': 'junk' }));
    const j = loadSettings(file);
    expect(j.ok).toBe(true);
    expect(writeTypeProblem('a.txt', false, associationMatcher(j.ok ? j.settings['files.associations'] : null))).toBeNull();
  });
});
