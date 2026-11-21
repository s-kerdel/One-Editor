// Folder deletes over stdio with the official SDK client: the built server asks the user through MCP
// elicitation (the client's handler answers accept / decline / cancel / confirm=false, or never), and falls
// back to the two-step summary + code for a client without elicitation. Trash: SEC_EDIT_TRASH_DIR inside
// the run folder (a test hook, dead when packaged). No browser: E2E_SKIP_BUILD=1 skips the renderer build.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOKEN_ENV, generateToken, hashToken, tokenHint } from '../../src/mcp/tokens';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const BASE = process.env.SEC_EDIT_E2E_TMP ? path.join(process.env.SEC_EDIT_E2E_TMP, 'mcp-delete') : path.join(ROOT, '.tmp/mcp/e2e-delete');
let CLI = process.env.SEC_EDIT_MCP_CLI ?? '';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  if (CLI) return;
  const out = path.join(ROOT, '.tmp/mcp/dist');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-node.mjs'), '--only', 'mcp', '--outdir', out], { cwd: ROOT, stdio: 'pipe' });
  CLI = path.join(out, 'mcp/cli.mjs');
});
test.afterAll(async () => {
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } | 'never';

async function connect(answer: Answer | null) {
  await fsp.mkdir(BASE, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(BASE, 'run-'));
  const ws = path.join(dir, 'notes');
  const config = path.join(dir, 'config');
  for (const [p, t] of [['proj/a.md', '# A\n'], ['proj/.git/config', '[core]\n'], ['proj/.env', 'X=1\n'], ['keep.md', 'keep\n']]) {
    await fsp.mkdir(path.dirname(path.join(ws, p)), { recursive: true });
    await fsp.writeFile(path.join(ws, p), t);
  }
  await fsp.mkdir(config, { recursive: true });
  const token = generateToken();
  fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify({ version: 1, enabled: true, folders: [{ id: 'a1b2c3d4', alias: 'notes', path: ws, mode: 'write' }], tokens: [{ id: 'c0ffee03', name: 'delete-e2e', sha256: hashToken(token), hint: tokenHint(token), created: Date.now() }] }));
  const env = { PATH: process.env.PATH ?? '', HOME: dir, SEC_EDIT_CONFIG_DIR: config, SEC_EDIT_TRASH_DIR: path.join(dir, 'trash'), SEC_EDIT_MCP_ELICIT_MS: '1500', [TOKEN_ENV]: token };
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--stdio'], env, stderr: 'pipe' });
  const client = new Client({ name: 'delete-e2e', version: '1' }, { capabilities: answer ? { elicitation: {} } : {} });
  const asked: string[] = [];
  if (answer)
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(String(req.params.message));
      if (answer === 'never') return new Promise(() => {});
      return answer;
    });
  await client.connect(transport);
  const call = async (args: Record<string, unknown>) => ((await client.callTool({ name: 'delete', arguments: args })) as any).content[0].text as string;
  return { dir, ws, client, asked, call };
}

const SUMMARY = 'Delete folder "proj" and everything in it? 3 files, 1 folder, 15 B (including hidden items such as .env, .git). It goes to the Recycle Bin.';

for (const [label, answer, want, deleted] of [
  ['accept, confirm=true', { action: 'accept', content: { confirm: true } }, /^Deleted folder proj \(3 files, 1 folder, 15 B\) to the Recycle Bin/, true],
  ['accept, confirm=false', { action: 'accept', content: { confirm: false } }, /^ECANCELED: Not deleted: the user declined$/, false],
  ['decline', { action: 'decline' }, /^ECANCELED: Not deleted: the user declined$/, false],
  ['cancel', { action: 'cancel' }, /^ECANCELED: Not deleted: the user did not answer$/, false],
  ['no answer (timeout)', 'never', /^ECANCELED: Not deleted: the user did not answer$/, false],
] as Array<[string, Answer, RegExp, boolean]>) {
  test(`elicitation: ${label}`, async () => {
    const r = await connect(answer);
    try {
      expect(await r.call({ path: 'proj' })).toMatch(want);
      expect(r.asked).toEqual([SUMMARY]);
      expect(fs.existsSync(path.join(r.ws, 'proj/.git/config'))).toBe(!deleted);
      if (deleted) expect(fs.readdirSync(path.join(r.dir, 'trash'))).toEqual(['proj']);
      expect(fs.existsSync(path.join(r.ws, 'keep.md'))).toBe(true);
    } finally {
      await r.client.close();
    }
  });
}

test('no elicitation: a summary and a code first; the code deletes once; a file delete asks nothing', async () => {
  const r = await connect(null);
  try {
    const first = await r.call({ path: 'proj' });
    expect(first.startsWith(SUMMARY)).toBe(true);
    const code = /· confirm: (\S+)$/.exec(first)![1];
    expect(fs.existsSync(path.join(r.ws, 'proj'))).toBe(true);
    expect(await r.call({ path: 'proj', confirm: 'ZZZZ-ZZZZ' })).toMatch(/^ECONFIRM: Not deleted: that confirm code is not valid/);
    expect(await r.call({ path: 'proj', confirm: code })).toMatch(/^Deleted folder proj/);
    expect(fs.existsSync(path.join(r.ws, 'proj'))).toBe(false);
    expect(await r.call({ path: 'keep.md' })).toMatch(/^Deleted keep\.md \(Recycle Bin\) · undo: /);
    expect(fs.readdirSync(path.join(r.dir, 'trash')).sort()).toEqual(['keep.md', 'proj']);
  } finally {
    await r.client.close();
  }
});
