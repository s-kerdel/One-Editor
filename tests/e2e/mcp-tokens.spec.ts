// Access tokens over stdio, end to end: the built server (dist/mcp/cli.mjs) reads ONE_MCP_TOKEN from its
// environment at startup, compares its hash with mcp.json's, and refuses (one stderr line, exit 1, nothing
// on stdout) when it is missing, unknown or revoked; a token revoked while running ends the server. Activity
// rows carry the token's name and id. No browser: E2E_SKIP_BUILD=1 skips the renderer build.
import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOKEN_ENV, generateToken, hashToken, tokenHint } from '../../src/mcp/tokens';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const BASE = process.env.SEC_EDIT_E2E_TMP ? path.join(process.env.SEC_EDIT_E2E_TMP, 'mcp-tokens') : path.join(ROOT, '.tmp/mcp/e2e-tokens');
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

async function rig() {
  await fsp.mkdir(BASE, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(BASE, 'run-'));
  const ws = path.join(dir, 'notes');
  const config = path.join(dir, 'config');
  await fsp.mkdir(ws, { recursive: true });
  await fsp.mkdir(config, { recursive: true });
  await fsp.writeFile(path.join(ws, 'a.md'), '# A\n\nhello\n');
  const token = generateToken();
  const rec = { id: 'abcdef01', name: 'LM Studio', sha256: hashToken(token), hint: tokenHint(token), created: Date.now() };
  const write = (tokens: unknown[]) => fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify({ version: 1, enabled: true, folders: [{ id: 'a1b2c3d4', alias: 'notes', path: ws, mode: 'read' }], tokens }));
  write([rec]);
  const env = (t?: string) => ({ PATH: process.env.PATH ?? '', HOME: dir, SEC_EDIT_CONFIG_DIR: config, SEC_EDIT_MCP_POLL_MS: '150', ...(t === undefined ? {} : { [TOKEN_ENV]: t }) });
  return { dir, ws, config, token, rec, write, env };
}

/** Starts the server raw and waits for it to exit (or not, within `ms`). */
async function run(env: Record<string, string>, args: string[] = [], ms = 8000) {
  const child = spawn(process.execPath, [CLI, '--stdio', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise<number | null | 'running'>((res) => {
    const t = setTimeout(() => res('running'), ms);
    child.on('exit', (c) => (clearTimeout(t), res(c)));
  });
  if (code === 'running') child.kill();
  return { code, out, err };
}

test('no token, a wrong one, a malformed one or one passed as an argument: refused, nothing on stdout', async () => {
  const r = await rig();
  for (const [label, env, args] of [
    ['missing', r.env(), []],
    ['unknown', r.env(generateToken()), []],
    ['malformed', r.env('one_short'), []],
    ['hash instead of token', r.env(r.rec.sha256), []],
  ] as const) {
    const res = await run(env as Record<string, string>, args as unknown as string[]);
    expect(res.code, label).toBe(1);
    expect(res.out, label).toBe('');
    expect(res.err.trim().split('\n'), label).toHaveLength(1);
    expect(res.err, label).toMatch(/access token/);
    expect(res.err, label).not.toContain(r.token);
  }
  expect((await run(r.env())).err).toContain('a token is now required');
  // On the command line, in any shape: refused, and neither the token nor any other argument is echoed.
  const part = r.token.slice(0, 24); // a fragment is refused too
  for (const args of [['--token', r.token], [r.token], [`--token=${r.token}`], [`ONE_MCP_TOKEN=${r.token}`], ['--folder', r.token], ['--stdio', `x${part}`], ['--stdio', '--folder', r.token]]) {
    const res = await run(r.env(r.token), args);
    expect(res.code, args.join(' ')).toBe(2);
    expect(res.out).toBe('');
    expect(res.err, args.join(' ')).not.toContain(part);
    expect(res.err).toContain('never in the arguments');
  }
  for (const args of [['--stdio', '--bogus-secret-name'], ['--stdio', '--folder', 'private-project-name']]) {
    const res = await run(r.env(r.token), args);
    expect(res.code, args.join(' ')).not.toBe(0);
    expect(res.err).not.toContain(args.at(-1)!.replace(/^--/, ''));
  }
});

test('the right token works; activity rows name the token; revoking it ends the running server', async () => {
  const r = await rig();
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--stdio'], env: r.env(r.token), stderr: 'pipe' });
  const client = new Client({ name: 'claims-to-be-someone-else', version: '1' });
  await client.connect(transport);
  let closed = false;
  transport.onclose = () => void (closed = true);
  try {
    const res: any = await client.callTool({ name: 'read_file', arguments: { path: 'a.md' } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('hello');
    await expect
      .poll(() => {
        try {
          return fs.readFileSync(path.join(r.config, 'mcp-audit.jsonl'), 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('read_file');
    const row = JSON.parse(fs.readFileSync(path.join(r.config, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(row).toMatchObject({ client: 'LM Studio', token: 'abcdef01' }); // the user's label, not what the client claims
    // Another token stays valid; this one is revoked while the server runs.
    const other = generateToken();
    r.write([{ id: 'abcdef02', name: 'Codex', sha256: hashToken(other), hint: tokenHint(other), created: Date.now() }]);
    await expect.poll(() => closed, { timeout: 8000 }).toBe(true);
  } finally {
    await client.close().catch(() => {});
  }
  // And it cannot start again with it.
  expect((await run(r.env(r.token))).code).toBe(1);
});

test('"MCP active": a running server has a live file (pid, the token\'s name, start, last call: nothing else); it goes when the server ends', async () => {
  const r = await rig();
  const liveDir = path.join(r.config, 'mcp-live');
  const files = () => (fs.existsSync(liveDir) ? fs.readdirSync(liveDir).filter((x) => x.endsWith('.json')) : []);
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--stdio'], env: r.env(r.token), stderr: 'pipe' });
  const client = new Client({ name: 'live-e2e', version: '1' });
  await client.connect(transport);
  try {
    await expect.poll(files, { timeout: 5000 }).toHaveLength(1);
    const file = path.join(liveDir, files()[0]);
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(first).sort()).toEqual(['client', 'lastCall', 'pid', 'started', 'v']);
    expect(first).toMatchObject({ v: 1, client: 'LM Studio', lastCall: null });
    expect(files()[0]).toBe(`${first.pid}-${files()[0].split('-')[1]}`);
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of [r.token, r.ws, 'a.md']) expect(text).not.toContain(secret);
    await client.callTool({ name: 'read_file', arguments: { path: 'a.md' } });
    // Throttled (at most every few seconds): the last call shows up shortly.
    await expect.poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).lastCall, { timeout: 8000 }).not.toBeNull();
  } finally {
    await client.close();
  }
  await expect.poll(files, { timeout: 5000 }).toEqual([]);
});
