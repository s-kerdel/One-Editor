// Security audit 2026-11-27, MCP batch (the confirmation code: folder-delete.test.ts / batch.test.ts; regexes:
// search/loose-phrase.test.ts, backend/gitignore.test.ts): files other tools obey or run later (M6), more
// never-written script types and One's own program folders (M7), 8.3 names on every platform (M8), One's text
// cache folder (L17), one-pass line numbers (L20), more key files and clean activity rows (info).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { parseActivityLine } from '../../../src/shared/mcp';
import { OneMcpServer } from '../../../src/mcp/server';
import { WriteQuota } from '../../../src/mcp/writes';
import { Visibility, cleanPath, grantProblem, writeTypeProblem } from '../../../src/mcp/folders';
import { folderProblem, oneInstallDirs } from '../../../src/mcp/grant';
import { matchLines } from '../../../src/mcp/tools/write';
import { associationMatcher } from '../../../src/shared/languages';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const cleanup: Array<() => unknown> = [];
beforeAll(() => {
  tmp = path.join(BASE, `review7-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const c of cleanup) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function server(allowCode: boolean) {
  const root = path.join(tmp, `ws-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(root, { recursive: true });
  const s = new OneMcpServer({ configDir: path.join(tmp, 'cfg'), settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, writes: true, quota: new WriteQuota({ session: 10_000, perMinute: 10_000 }) });
  cleanup.push(() => s.dispose());
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode: 'write', allowCode }] });
  let id = 1;
  await s.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'review7' } } });
  const write = async (p: string) => {
    const r = (await s.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'write_file', arguments: { path: p, content: 'x\n' } } })) as any;
    return { isError: !!r.result.isError, text: r.result.content[0].text as string, exists: fs.existsSync(path.join(root, ...p.split('/'))) };
  };
  return { root, write };
}

describe('M6: notes other tools obey or run later need the code grant', () => {
  const OBEYED = ['CLAUDE.md', 'sub/CLAUDE.md', 'claude.local.md', 'AGENTS.md', 'AGENTS.override.md', 'AGENT.md', 'GEMINI.md', 'QWEN.md', 'CRUSH.md', 'WARP.md', 'skills/x/SKILL.md', 'review.instructions.md', 'fix.prompt.md', 'CMakeLists.txt', 'src/cmakelists.txt', 'requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt', 'requirements/base.txt'];
  it('refused for notes-only folders, written with the code grant; ordinary notes unchanged', () => {
    for (const p of OBEYED) {
      expect(writeTypeProblem(p, false), p).toMatch(/run or obeyed later.*Also allow code and config files/);
      expect(writeTypeProblem(p, true), p).toBeNull();
    }
    for (const p of ['notes.md', 'readme.md', 'todo.txt', 'claude-notes.md', 'agents/plan.md', 'requirements.md', 'docs/base.txt', 'my.prompt.txt']) expect(writeTypeProblem(p, false), p).toBeNull();
    // A user mapping cannot loosen it (markdown / text mappings keep the name's own rule).
    expect(writeTypeProblem('CLAUDE.md', false, associationMatcher({ 'CLAUDE.md': 'markdown' }))).toMatch(/obeyed later/);
  });

  it('through write_file', async () => {
    const notes = await server(false);
    const r = await notes.write('CLAUDE.md');
    expect(r).toMatchObject({ isError: true, exists: false });
    expect(r.text).toMatch(/^EINVAL: Cannot change CLAUDE\.md: agent instructions and build files/);
    expect((await notes.write('requirements.txt')).exists).toBe(false);
    expect((await notes.write('plan.md')).isError).toBe(false);
    const code = await server(true);
    expect((await code.write('AGENTS.md')).exists).toBe(true);
  });
});

describe('M7: script types never written; One’s own program folders never shared', () => {
  it('shell, Ruby and Perl scripts (and other auto-run types): never, whatever the grant or mapping', () => {
    for (const ext of ['sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'rb', 'rbw', 'pl', 'pm', 'pth', 'pyz', 'inf', 'ahk', 'tool', 'terminal'])
      for (const code of [false, true]) expect(writeTypeProblem(`x.${ext}`, code), ext).toMatch(/never written/);
    expect(writeTypeProblem('notes.txt', true, associationMatcher({ '*.txt': 'shell' }))).toMatch(/never written/);
    expect(writeTypeProblem('a.ts', true)).toBeNull(); // other code stays a code-grant matter
  });

  it('the install folder: neither the folder, a folder around it nor one inside it', () => {
    const w = { configDir: 'C:\\Users\\me\\AppData\\Roaming\\sec-edit', homedir: 'C:\\Users\\me', foldCase: true, p: path.win32, installDirs: ['C:\\Users\\me\\AppData\\Local\\Programs\\One'] };
    for (const f of ['C:\\Users\\me\\AppData\\Local\\Programs', 'c:\\users\\me\\appdata\\local\\programs\\one', 'C:\\Users\\me\\AppData\\Local\\Programs\\One\\resources\\app.asar.unpacked'])
      expect(folderProblem(f, w), f).toMatch(/One itself/);
    expect(folderProblem('C:\\Users\\me\\AppData\\Local\\Programs\\Other', w)).toBeNull();
    expect(folderProblem('C:\\Users\\me\\Notes', w)).toBeNull();
  });

  it('which folders those are (macOS: the bundle’s Contents), and the server refuses this process’s own', () => {
    expect(oneInstallDirs('/Applications/One.app/Contents/MacOS/One', undefined)).toEqual(['/Applications/One.app/Contents/MacOS', '/Applications/One.app/Contents']);
    expect(oneInstallDirs('/opt/One/one', '/opt/One/resources')).toEqual(['/opt/One', '/opt/One/resources']);
    const env = { configDir: path.join(tmp, 'cfg'), homedir: path.join(tmp, 'home'), win: false };
    expect(grantProblem(path.dirname(process.execPath), env)).toMatch(/One itself/);
    expect(grantProblem(path.dirname(path.dirname(process.execPath)), env)).toMatch(/One itself/);
    expect(grantProblem(path.join(tmp, 'notes'), env)).toBeNull();
  });
});

describe('M8: 8.3 short names are refused on every platform', () => {
  it('Linux / WSL builds read FAT and NTFS volumes too', () => {
    for (const p of ['ENV~1', 'GITHUB~1/workflows/x.yml', 'a/PRIVAT~1.MD', 'ID_RSA~1']) expect(() => cleanPath(p, { win: false }), p).toThrow(/short \(8\.3\) name/);
    for (const p of ['notes~2026.md', 'draft~v2.md', 'a~b.md', 'longername~1.md']) expect(cleanPath(p, { win: false }), p).toBe(p);
  });
});

describe('L17: One’s text cache folder is refused like its data folder', () => {
  it('Windows: %LOCALAPPDATA%\\sec-edit (outside the roaming data folder)', () => {
    const w = { configDir: 'C:\\Users\\me\\AppData\\Roaming\\sec-edit', homedir: 'C:\\Users\\me', foldCase: true, p: path.win32, installDirs: [], cacheDir: 'C:\\Users\\me\\AppData\\Local\\sec-edit\\index-cache' };
    for (const f of ['C:\\Users\\me\\AppData\\Local', 'C:\\Users\\me\\AppData\\Local\\sec-edit', 'C:\\Users\\me\\AppData\\Local\\sec-edit\\index-cache\\x'])
      expect(folderProblem(f, w), f).toMatch(/own data/);
    expect(folderProblem('C:\\Users\\me\\AppData\\Local\\Other', w)).toBeNull();
  });
});

describe('L20: replace_text all names secret lines in one pass', () => {
  it('the same lines as counting from the start, without the quadratic walk', () => {
    const small = 'a old\nold b\n\nx old\nold\n';
    expect(matchLines(small, 'old')).toEqual([[0], [1], [3], [4]]);
    expect(matchLines('one\ntwo old\nthree', 'old\nthr')).toEqual([[1, 2]]);
    const big = 'x\n'.repeat(500_000) + 'old\n'.repeat(1000);
    const t = performance.now();
    const lines = matchLines(big, 'old');
    expect(performance.now() - t).toBeLessThan(1000);
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toEqual([500_000]);
    expect(lines.at(-1)).toEqual([500_999]);
  });
});

describe('info: more key files; activity rows show hidden characters', () => {
  it('armored keys, VPN profiles, Terraform variables, netrc, kubeconfigs are never visible', () => {
    const v = new Visibility([]);
    for (const p of ['keys/me.asc', 'vpn/home.ovpn', 'prod.tfvars', 'env/prod.tfvars.json', '_netrc', '.netrc', 'cluster.kubeconfig', 'PROD.TFVARS']) expect(v.hidden(p), p).toBe(true);
    expect(v.hidden('notes/terraform.md')).toBe(false);
  });

  it('bidi overrides and zero-width characters in a row become one visible mark', () => {
    const row = parseActivityLine(JSON.stringify({ t: 1, tool: 'read_file', client: 'LM\u200b Studio', folder: 'no\u2066tes', path: 'invoice\u202Egpj.exe', note: 'x\u200d\u200dy', ok: true }))!;
    expect(row.path).toBe('invoice\uFFFDgpj.exe');
    expect(row.client).toBe('LM\uFFFD Studio');
    expect(row.folder).toBe('no\uFFFDtes');
    expect(row.note).toBe('x\uFFFDy');
    expect(parseActivityLine(JSON.stringify({ t: 1, tool: 'read_file', client: 'LM\u0007 Studio' }))!.client).toBe('LM Studio'); // C0 controls still dropped
  });
});
