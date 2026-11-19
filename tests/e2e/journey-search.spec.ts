// Journey 2 — "Search torture": real commands with quotes/pipes/redirects/globs/env vars must be found
// exactly (and near-miss decoys must not), through the real search panel.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './harness';
import { boot, content, cursor, focusEditorEnd, openSearch, openViaTree, trackErrors } from './journey.helpers';
import { writeCorpus } from './journey.corpus';

/** Visible result rows as "path:line0" (sorted), read from the DOM. */
const rows = (page: Page) =>
  page.locator('.se-sr-match').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.path}:${(e as HTMLElement).dataset.line}`).sort());

/** Type a query into the panel and wait until exactly `expected` rows are listed. */
async function expectRows(page: Page, input: Locator, query: string, expected: string[]) {
  await input.fill(query);
  await expect.poll(() => rows(page), { message: `rows for query: ${query}` }).toEqual([...expected].sort());
  if (!expected.length) await expect(page.locator('.se-sr-file'), `files for query: ${query}`).toHaveCount(0);
}

test.beforeEach(async ({ ws }) => {
  await writeCorpus(ws.root);
});

test('pasted commands are found verbatim: one row, right context, no decoys', async ({ page, ws }) => {
  const errors = trackErrors(page);
  await boot(page, ws);
  const input = await openSearch(page);
  // [query, expected row, context badge]
  const cases: Array<[string, string, string]> = [
    ['grep -rn "TODO" . | wc -l', 'qa/shell.md:5', 'bash'],
    ['export PATH="$HOME/bin:$PATH"', 'qa/shell.md:6', 'bash'],
    ['$HOME/bin', 'qa/shell.md:6', 'bash'],
    ['rm -rf ./node_modules/*', 'qa/shell.md:7', 'bash'],
    [`curl -X POST -H 'Content-Type: application/json' -d '{"a":1}'`, 'qa/shell.md:8', 'bash'],
    [`-d '{"a":1}'`, 'qa/shell.md:8', 'bash'],
    ['> /dev/null 2>&1', 'qa/shell.md:9', 'bash'],
    ['2>&1', 'qa/shell.md:9', 'bash'],
    ['docker run --rm -it -v "$PWD":/app -w /app node:20 npm test', 'qa/shell.md:10', 'bash'],
    ['-v "$PWD":/app', 'qa/shell.md:10', 'bash'],
    ['SELECT * FROM users WHERE id = 1;', 'qa/sql.md:3', 'sql'],
    ['Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1MB }', 'qa/powershell.md:5', 'powershell'],
    ['$_.Length', 'qa/powershell.md:5', 'powershell'],
  ];
  for (const [q, row, badge] of cases) {
    await expectRows(page, input, q, [row]);
    const r = page.locator('.se-sr-match');
    await expect(r.locator('.se-badge-code'), q).toHaveText(badge);
    // The whole pasted command is highlighted as one continuous hit.
    await expect(r.locator('mark.se-hit'), q).toHaveText(q);
    await expect(page.locator('.se-badge-fuzzy'), q).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('Windows paths, CRLF files, unicode and text mixed with inline code', async ({ page, ws }) => {
  await boot(page, ws);
  const input = await openSearch(page);

  // Windows path in prose of a CRLF file; the decoy "C:\Program Files (x86)\nodejs" must not match.
  await expectRows(page, input, 'C:\\Program Files\\nodejs\\node.exe', ['qa/powershell.md:2']);
  await expect(page.locator('.se-sr-match mark.se-hit')).toHaveText('C:\\Program Files\\nodejs\\node.exe');
  // Clicking a hit in a CRLF file selects exactly the match (offsets are not shifted by \r).
  await page.locator('.se-sr-match').click();
  await expect.poll(() => cursor(page)).toMatchObject({ path: 'qa/powershell.md', line: 2, sel: 'C:\\Program Files\\nodejs\\node.exe' });
  await expectRows(page, input, '{ $_.Length -gt 1MB }', ['qa/powershell.md:5']);
  await page.locator('.se-sr-match').click();
  await expect.poll(() => cursor(page)).toMatchObject({ path: 'qa/powershell.md', line: 5, sel: '{ $_.Length -gt 1MB }' });

  // Unicode: accents (exact and folded), CJK, emoji, ß/ö.
  await expectRows(page, input, 'résumé', ['qa/unicode.md:2']);
  await expectRows(page, input, 'resume', ['qa/unicode.md:2']);
  await expect(page.locator('.se-sr-match mark.se-hit')).toHaveText('résumé');
  await expectRows(page, input, '日本語', ['qa/unicode.md:2']);
  await expectRows(page, input, '🚀', ['qa/unicode.md:2']);
  await expectRows(page, input, 'größe', ['qa/unicode.md:3']);

  // A sentence that runs through inline code: "Run `npm run build` before pushing to main."
  await expectRows(page, input, 'npm run build before pushing', ['qa/shell.md:13']);
  await expectRows(page, input, '"build before pushing"', ['qa/shell.md:13']);
  await expectRows(page, input, 'in:inline npm run build', ['qa/shell.md:13']);
  await expect(page.locator('.se-sr-match .se-badge-inline')).toBeVisible();
});

test('regex mode, case toggle and whole word', async ({ page, ws }) => {
  await boot(page, ws);
  const input = await openSearch(page);
  const regex = page.getByLabel('Use regular expression');
  const matchCase = page.getByLabel('Match case');

  // Smart case: lowercase finds any case, uppercase is exact.
  await expectRows(page, input, 'select', ['qa/sql.md:3', 'code/query.sql:0', 'qa/decoy.md:2']);
  await expectRows(page, input, 'SELECT', ['qa/sql.md:3']);
  await matchCase.click();
  await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
  await expectRows(page, input, 'select', ['code/query.sql:0', 'qa/decoy.md:2']);
  await matchCase.click();
  await expectRows(page, input, 'select', ['qa/sql.md:3', 'code/query.sql:0', 'qa/decoy.md:2']);

  // Regex toggle: the whole box is one pattern.
  await regex.click();
  await expectRows(page, input, 'wc -[lc]$', ['qa/shell.md:5', 'qa/decoy.md:5']);
  await expectRows(page, input, 'rm -rf \\./(?!dist)\\w+/\\*', ['qa/shell.md:7']);
  await expectRows(page, input, '^export PATH="\\$HOME', ['qa/shell.md:6']);
  await input.fill('wc -[');
  await expect(page.locator('.se-search-error')).toBeVisible(); // invalid pattern is reported, not thrown
  await regex.click();
  // With the toggle off the same text is literal again.
  await expectRows(page, input, 'wc -[lc]$', []);
  // Inline /regex/ works without the toggle.
  await expectRows(page, input, '/rm -rf \\.\\/\\w+\\/\\*/', ['qa/shell.md:7', 'qa/decoy.md:7']);

  // Whole word: "Recurs" is only a prefix of "-Recurse".
  await expectRows(page, input, 'Recurs', ['qa/powershell.md:5']);
  await page.getByLabel('Match whole word').click();
  await expect.poll(() => page.locator('.se-sr-file:not(:has(.se-badge-fuzzy))').count()).toBe(0);
  await expectRows(page, input, 'Recurse', ['qa/powershell.md:5']);
});

test('filters: lang:, in:code, path: and negation', async ({ page, ws }) => {
  await boot(page, ws);
  const input = await openSearch(page);
  // "users" occurs in sql code, php code and in decoy prose.
  await expectRows(page, input, 'users', ['qa/sql.md:3', 'code/query.sql:0', 'qa/decoy.md:2', 'code/UserController.php:4', 'code/UserController.php:5']);
  await expectRows(page, input, 'lang:sql users', ['qa/sql.md:3', 'code/query.sql:0']);
  await expect(page.locator('.se-chip-filter')).toHaveText('lang:sql');
  await expectRows(page, input, 'in:code users', ['qa/sql.md:3', 'code/query.sql:0', 'code/UserController.php:4', 'code/UserController.php:5']);
  await expectRows(page, input, 'in:text users', ['qa/decoy.md:2']);
  await expectRows(page, input, 'path:qa users', ['qa/sql.md:3', 'qa/decoy.md:2']);
  await expectRows(page, input, 'path:qa -path:decoy users', ['qa/sql.md:3']);
  await expectRows(page, input, 'lang:powershell Recurse', ['qa/powershell.md:5']);
  await expectRows(page, input, 'lang:bash wc', ['qa/shell.md:5', 'qa/decoy.md:5']);
  await expectRows(page, input, 'lang:bash in:code path:shell wc -l', ['qa/shell.md:5']);
  // grep only ever appears inside code blocks.
  await expectRows(page, input, 'in:text grep', []);
  await expect(page.locator('.se-badge-fuzzy')).toHaveCount(0);
});

test('the index follows reality: unsaved typing, external edits, deletes and renames', async ({ page, ws }) => {
  const errors = trackErrors(page);
  await boot(page, ws);
  // Keep the buffer unsaved so we prove the *editor text* is searched, not the disk.
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, autosave: false };
  });
  await openViaTree(page, 'qa/sql.md');
  await focusEditorEnd(page);
  await page.keyboard.type('\nRun `docker exec -it web sh -c "ls /var/www"` to look around.');
  const input = await openSearch(page);
  await expectRows(page, input, 'sh -c "ls /var/www"', ['qa/sql.md:6']);
  await expect(page.locator('.se-sr-match .se-badge-inline')).toBeVisible();
  expect(await ws.read('qa/sql.md')).not.toContain('docker exec');
  await page.keyboard.press('Control+s');
  await expect.poll(() => ws.read('qa/sql.md')).toContain('docker exec -it web sh -c "ls /var/www"');

  // External edit of a closed file: new text is found, old text is gone — without retyping the query.
  await input.fill('lang:bash backup');
  await expect.poll(() => rows(page)).toEqual(['qa/shell.md:9']);
  await ws.write('qa/shell.md', '# Shell snippets\n\n```bash\nrsync -avz --delete ./backup/ user@host:/srv/backup/\n```\n');
  await expect.poll(() => rows(page), { timeout: 10000 }).toEqual(['qa/shell.md:3']);
  await expectRows(page, input, 'rsync -avz --delete ./backup/ user@host:/srv/backup/', ['qa/shell.md:3']);
  await expectRows(page, input, 'grep -rn "TODO"', []);

  // External edit of the open (clean) file: editor reloads and search follows.
  await ws.write('qa/sql.md', '# Queries\n\n```sql\nDELETE FROM sessions WHERE expires_at < NOW();\n```\n');
  await expect.poll(() => content(page, 'qa/sql.md')).toContain('DELETE FROM sessions');
  await expectRows(page, input, 'WHERE expires_at < NOW();', ['qa/sql.md:3']);
  await expectRows(page, input, 'docker exec -it web', []);

  // Deleted on disk → gone from results (query stays in the box).
  await expectRows(page, input, '日本語', ['qa/unicode.md:2']);
  await fsp.rm(path.join(ws.root, 'qa/unicode.md'));
  await expect.poll(() => rows(page), { timeout: 10000 }).toEqual([]);

  // Renamed on disk → listed under the new name only.
  await expectRows(page, input, 'FIXME', ['qa/decoy.md:5']);
  await fsp.rename(path.join(ws.root, 'qa/decoy.md'), path.join(ws.root, 'qa/old-decoy.md'));
  await expect.poll(() => rows(page), { timeout: 10000 }).toEqual(['qa/old-decoy.md:5']);
  expect(errors).toEqual([]);
});
