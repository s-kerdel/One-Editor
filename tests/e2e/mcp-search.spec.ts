// MCP search through the built server over stdio (official SDK client): every filter of One's query
// syntax (path: file: ext: lang: tag: in: case:, negated, comma lists, quoted values, globs) and the
// operators ("phrase", -word, OR; /regex/ stays plain text) pick exactly the right files. Each query runs
// in `files` mode (paths + counts), so a wrong or extra file shows up as a diff of two lists.
// No browser: run with E2E_SKIP_BUILD=1. SEC_EDIT_MCP_CLI=<cli.mjs> tests another build.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOKEN_ENV, generateToken, hashToken, tokenHint } from '../../src/mcp/tokens';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const BASE = process.env.SEC_EDIT_E2E_TMP ? path.join(process.env.SEC_EDIT_E2E_TMP, 'mcp-search') : path.join(ROOT, '.tmp/mcp/e2e-search');
let CLI = process.env.SEC_EDIT_MCP_CLI ?? '';

test.describe.configure({ mode: 'serial' });

const NOTES: Record<string, string> = {
  'notes/deploy.md': '# Deploy\n\nRun the deploy steps.\n\n```bash\ndeploy --prod\n```\n\nUse `deploy-inline` here. #ops\n',
  'notes/todo.md': '---\nstatus: deploy-pending\ntags: [work]\n---\n# Todo\n\n- deploy later\n',
  'notes/links.md': '# Links\n\nSee [[deploy]] for the steps.\n',
  'notes/Case.md': '# Case\n\nDeploy with a capital D.\n',
  'notes/sql-note.md': '# SQL\n\n```sql\nselect deploy from t;\n```\n',
  'notes/heading.md': '# Deploy heading\n\nnothing else\n',
  'archive/old.md': '# Old\n\ndeploy the old way\n',
  'code/schema.sql': '-- deploy table\nCREATE TABLE deploy (id int);\n',
  'code/app.php': '<?php\n// deploy hook\nfunction deploy() {}\n',
  'my docs/spaced.md': 'deploy in a folder with a space\n',
};

let client: Client;
let dir = '';

test.beforeAll(async () => {
  if (!CLI) {
    const out = path.join(BASE, 'dist');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-node.mjs'), '--only', 'mcp', '--outdir', out], { cwd: ROOT, stdio: 'pipe' });
    CLI = path.join(out, 'mcp/cli.mjs');
  }
  await fsp.mkdir(BASE, { recursive: true });
  dir = await fsp.mkdtemp(path.join(BASE, 'run-'));
  const ws = path.join(dir, 'workspace');
  const config = path.join(dir, 'config');
  for (const [rel, text] of Object.entries(NOTES)) {
    await fsp.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fsp.writeFile(path.join(ws, rel), text);
  }
  await fsp.mkdir(config, { recursive: true });
  const token = generateToken();
  const tokens = [{ id: 'c0ffee01', name: 'e2e', sha256: hashToken(token), hint: tokenHint(token), created: Date.now() }];
  fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify({ version: 1, enabled: true, folders: [{ id: 'a1b2c3d4', alias: 'fixture', path: ws, mode: 'read' }], tokens }));
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({}));
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { PATH: process.env.PATH ?? '', SEC_EDIT_CONFIG_DIR: config, TMPDIR: tmp, HOME: dir, [TOKEN_ENV]: token };
  client = new Client({ name: 'e2e-search', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--stdio'], env, stderr: 'pipe' }));
});

test.afterAll(async () => {
  await client?.close();
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});

const answer = async (args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name: 'search', arguments: args });
  expect(r.isError, r.content[0].text).toBeFalsy();
  expect(r.content).toHaveLength(1);
  return r.content[0].text as string;
};
/** The files a query selects, sorted (files mode rows: `path (count)` or a bare path for filter-only queries). */
const files = async (query: string) => {
  const t = await answer({ query, mode: 'files' });
  if (t.startsWith('No matches')) return [];
  return t.split('\n').slice(1).map((r) => r.replace(/ \(\d+\)$/, '')).sort();
};
const ALL = Object.keys(NOTES).sort();
const except = (...gone: string[]) => ALL.filter((p) => !gone.includes(p));

test('every filter and operator picks the right files', async () => {
  const cases: Array<[string, string[]]> = [
    // path: file: (substring, glob, quoted value, negated)
    ['deploy path:notes/', ['notes/Case.md', 'notes/deploy.md', 'notes/heading.md', 'notes/links.md', 'notes/sql-note.md', 'notes/todo.md']],
    ['deploy -path:archive', except('archive/old.md')],
    ['deploy -path:archive -path:notes/', ['code/app.php', 'code/schema.sql', 'my docs/spaced.md']],
    ['deploy path:"my docs"', ['my docs/spaced.md']],
    ['deploy path:code/*.sql', ['code/schema.sql']],
    ['deploy file:todo', ['notes/todo.md']],
    ['deploy -file:todo path:notes/', ['notes/Case.md', 'notes/deploy.md', 'notes/heading.md', 'notes/links.md', 'notes/sql-note.md']],
    // ext: with a comma list, negated; filter-only queries list files
    ['deploy ext:php,sql', ['code/app.php', 'code/schema.sql']],
    ['deploy -ext:md', ['code/app.php', 'code/schema.sql']],
    ['ext:sql', ['code/schema.sql']],
    // lang: code files of that language and fenced blocks in notes
    ['deploy lang:sql', ['code/schema.sql', 'notes/sql-note.md']],
    ['deploy lang:php', ['code/app.php']],
    // tag: inline and frontmatter tags, negated
    ['deploy tag:ops', ['notes/deploy.md']],
    ['tag:work', ['notes/todo.md']],
    ['deploy -tag:ops path:notes/', ['notes/Case.md', 'notes/heading.md', 'notes/links.md', 'notes/sql-note.md', 'notes/todo.md']],
    // in: every context (and the aliases). Code files are code throughout; a word inside [[…]] is link, not text.
    ['deploy in:heading', ['notes/deploy.md', 'notes/heading.md']],
    ['deploy in:code', ['code/app.php', 'code/schema.sql', 'notes/deploy.md', 'notes/sql-note.md']],
    ['deploy in:block path:notes/', ['notes/deploy.md', 'notes/sql-note.md']],
    ['deploy in:fence ext:md', ['notes/deploy.md', 'notes/sql-note.md']],
    ['deploy in:inline', ['notes/deploy.md']],
    ['deploy in:frontmatter', ['notes/todo.md']],
    ['deploy in:fm', ['notes/todo.md']],
    ['deploy in:yaml', ['notes/todo.md']],
    ['deploy in:meta', ['notes/todo.md']],
    ['deploy in:link', ['notes/links.md']],
    ['deploy in:path', ['notes/deploy.md']],
    ['deploy in:text path:notes/', ['notes/Case.md', 'notes/deploy.md', 'notes/todo.md']],
    ['deploy -in:heading path:notes/', ['notes/Case.md', 'notes/deploy.md', 'notes/links.md', 'notes/sql-note.md', 'notes/todo.md']],
    // case: smart by default (a capital = exact), forced either way
    ['Deploy', ['notes/Case.md', 'notes/deploy.md', 'notes/heading.md']],
    ['deploy case:yes path:notes/', ['notes/deploy.md', 'notes/links.md', 'notes/sql-note.md', 'notes/todo.md']],
    ['Deploy case:no ext:sql', ['code/schema.sql']],
    // operators
    ['"deploy later"', ['notes/todo.md']],
    ['deploy -later path:notes/', ['notes/Case.md', 'notes/deploy.md', 'notes/heading.md', 'notes/links.md', 'notes/sql-note.md']],
    ['prod OR later', ['notes/deploy.md', 'notes/todo.md']],
    ['/depl.y/', []], // no regex over MCP: plain text
  ];
  const wrong: string[] = [];
  for (const [q, want] of cases) {
    const got = await files(q);
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) wrong.push(`${q}\n   want ${JSON.stringify([...want].sort())}\n   got  ${JSON.stringify(got)}`);
  }
  expect(wrong, wrong.join('\n')).toEqual([]);
});

test('lines mode shows the hit lines; context, names and headings modes; warnings and hints come back', async () => {
  const lines = await answer({ query: 'deploy in:block ext:md' });
  expect(lines.split('\n')[0]).toBe('2 matches in 2 files');
  expect(lines).toContain('notes/deploy.md\n  6: deploy --prod');
  expect(lines).toContain('notes/sql-note.md\n  4: select deploy from t;');
  const ctx = await answer({ query: '"deploy --prod"', context: 1 });
  expect(ctx.split('\n').slice(1)).toEqual(['notes/deploy.md', '  5- ```bash', '  6: deploy --prod', '  7- ```']);
  expect((await answer({ query: 'sql note', mode: 'names' })).split('\n')[1]).toBe('notes/sql-note.md');
  expect((await answer({ query: 'deploy heading', mode: 'headings' })).split('\n')[1]).toBe('notes/heading.md:1 # Deploy heading');
  expect(await answer({ query: 'deploy in:nowhere' })).toContain('note: Unknown in:nowhere');
  const r: any = await client.callTool({ name: 'search', arguments: { query: 'deploy', ext: 'sql' } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^EINVAL: Unknown parameter "ext".*Filters go inside query/);
});

test('the tool list teaches the syntax: search documents every filter key and in: value', async () => {
  const tools = (await client.listTools()).tools;
  const search = tools.find((t) => t.name === 'search')!;
  for (const k of ['path:', 'file:', 'ext:', 'lang:', 'tag:', 'in:', 'case:yes', '-filter', 'ext:php,sql', '-path:archive']) expect(search.description, k).toContain(k);
  for (const v of ['code', 'block', 'inline', 'text', 'heading', 'frontmatter', 'link', 'path']) expect(search.description).toMatch(new RegExp(`in:[a-z|]*\\b${v}\\b`));
  expect(client.getInstructions()).toContain('path:notes/ -path:archive');
});
