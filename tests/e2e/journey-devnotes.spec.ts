// Journey 1 — "Dev notes day": a developer writes a runbook note with the real keyboard, previews it,
// formats the PHP snippet and then finds the shell command again through search.
import { test, expect } from './harness';
import { active, boot, content, cursor, hit, openSearch, tab, trackErrors } from './journey.helpers';

const NOTE = 'Deploy runbook.md';
const CMD = 'kubectl rollout restart deployment/web --namespace=prod';

test('write a runbook note, preview it, format the PHP block, find the command via search', async ({ page, ws }) => {
  test.setTimeout(90_000);
  const errors = trackErrors(page);
  await boot(page, ws);

  // --- create + title (Ctrl+N → inline rename → focus lands in the editor) ---
  await page.keyboard.press('Control+n');
  await expect(page.locator('.se-tree-input')).toBeFocused();
  await page.keyboard.type('Deploy runbook');
  await page.keyboard.press('Enter');
  await expect(tab(page, NOTE)).toBeVisible();
  await expect(page.locator('.cm-content')).toBeFocused();

  // --- write, like a user would ---
  const kb = page.keyboard;
  // Enter after an opening fence auto-inserts the closing one: step over it instead of typing it.
  const leaveFence = async () => {
    await kb.press('ArrowDown');
    await kb.press('End');
    await kb.press('Enter');
    await kb.press('Enter');
  };
  await kb.type('# Deploy runbook');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('```bash');
  await kb.press('Enter');
  await kb.type(CMD);
  await leaveFence();
  await kb.type('```php');
  await kb.press('Enter');
  await kb.type('<?php');
  await kb.press('Enter');
  await kb.type('function  add( $a,$b ){return $a+$b;}');
  await leaveFence();
  await kb.type('- [ ] Check the pods');
  await kb.press('Enter'); // list continues with a fresh checkbox
  await kb.type('Tell the team');
  await kb.press('Enter');
  await kb.press('Enter'); // empty item → leaves the list
  await kb.press('Enter');
  await kb.type('> [!warning] Careful');
  await kb.press('Enter');
  await kb.type('Prod only.');
  await kb.press('Enter');
  await kb.press('Enter'); // empty quote line → leaves the callout
  await kb.press('Enter');
  await kb.type('See [[kube');
  const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'kubernetes' });
  await expect(option).toBeVisible();
  // CM ignores accept keys for 75 ms after the popup opens (interactionDelay) — there is no state to await.
  await page.waitForTimeout(200);
  await kb.press('Enter');
  await expect.poll(() => content(page)).toContain('See [[kubernetes]]');
  await kb.press('End');
  await kb.type(' for more.');

  const typed = await content(page);
  expect(typed).toBe(
    [
      '# Deploy runbook',
      '',
      '```bash',
      CMD,
      '```',
      '',
      '```php',
      '<?php',
      'function  add( $a,$b ){return $a+$b;}',
      '```',
      '',
      '- [ ] Check the pods',
      '- [ ] Tell the team',
      '',
      '> [!warning] Careful',
      '> Prod only.',
      '',
      'See [[kubernetes]] for more.',
    ].join('\n'),
  );

  // --- autosave reaches the disk without Ctrl+S ---
  await expect.poll(() => ws.read(NOTE), { timeout: 8000 }).toBe(typed);
  await expect(tab(page, NOTE).locator('.se-tab-dirty')).toHaveCount(0);

  // --- split view: preview shows highlighted code, the callout and the tasks ---
  await kb.press('Control+\\');
  await expect(page.locator('.se-editor-area.mode-split')).toBeVisible();
  const pv = page.locator('.se-preview');
  await expect(pv.locator('h1')).toHaveText('Deploy runbook');
  await expect(pv.locator('.se-code[data-lang="shellscript"] code')).toContainText(CMD);
  await expect(pv.locator('.se-code[data-lang="shellscript"] code span[style*="--shiki"]').first()).toBeVisible({ timeout: 15000 });
  await expect(pv.locator('.se-code[data-lang="php"] code span[style*="--shiki"]').first()).toBeVisible({ timeout: 15000 });
  await expect(pv.locator('.se-callout[data-callout="warning"] .se-callout-title')).toContainText('Careful');
  await expect(pv.locator('.se-callout[data-callout="warning"] .se-callout-content')).toContainText('Prod only.');
  await expect(pv.locator('input.se-task')).toHaveCount(2);
  await expect(pv.locator('a.se-wikilink', { hasText: 'kubernetes' })).toBeVisible();
  await expect(pv.locator('a.se-wikilink.is-unresolved')).toHaveCount(0);

  // --- format only the PHP block (cursor inside it, Ctrl+Alt+F) ---
  await page.locator('.cm-line', { hasText: 'function  add' }).click();
  await kb.press('Control+Alt+f');
  await expect.poll(() => content(page), { timeout: 20000 }).toContain('```php\n<?php\nfunction add($a, $b)\n{\n    return $a + $b;\n}\n```');
  const formatted = await content(page);
  expect(formatted).toContain('```bash\n' + CMD + '\n```'); // the other block is untouched
  await expect.poll(() => ws.read(NOTE), { timeout: 8000 }).toBe(formatted);
  await expect(pv.locator('.se-code[data-lang="php"] code')).toContainText('return $a + $b;');

  // --- search finds the command by any of its parts, flagged as bash code ---
  const input = await openSearch(page);
  for (const q of ['--namespace=prod', 'rollout restart', 'deployment/web']) {
    await input.fill(q);
    const r = hit(page, NOTE);
    await expect(r, `query ${q}`).toHaveCount(1);
    await expect(r.locator('.se-badge-code')).toHaveText('bash');
    await expect(r.locator('mark.se-hit').first()).toBeVisible();
  }
  await input.fill('--namespace=prod');
  await expect(hit(page, NOTE)).toHaveCount(1);
  await expect(page.locator('.se-search-summary')).toContainText('1 result in 1 file');

  // --- click the hit → the editor selects it ---
  await hit(page, NOTE).click();
  await expect.poll(() => cursor(page)).toMatchObject({ path: NOTE, line: 3, sel: '--namespace=prod', lineText: CMD });
  expect(await active(page)).toBe(NOTE);
  expect(errors).toEqual([]);
});

test('typing the closing ``` by hand (muscle memory) does not leave a stray fence behind', async ({ page, ws }) => {
  await boot(page, ws);
  await page.keyboard.press('Control+n');
  await expect(page.locator('.se-tree-input')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toBeFocused();
  for (const line of ['```bash', 'ls -la', '```', '', 'after']) {
    await page.keyboard.type(line);
    if (line !== 'after') await page.keyboard.press('Enter');
  }
  expect(await content(page)).toBe('```bash\nls -la\n```\n\nafter');
});
