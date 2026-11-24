// Smart paste (setting editor.smartPaste, default off): real clipboard → Ctrl+V → "Paste as…" chip.
// One undo step either way; plain paste stays unless an option is picked.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { cursorTo, openNote } from './editor-helpers';

const SHOTS = path.resolve('.tmp/vars/shots');
fs.mkdirSync(SHOTS, { recursive: true });

const content = (page: Page) => page.evaluate(() => (window as any).__secEdit.editor.getContent() as string);

async function setup(page: Page, ws: { root: string; open(p: Page): Promise<void> }, on = true) {
  fs.mkdirSync(path.join(ws.root, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'ops/paste.md'), 'Intro\n\n');
  await ws.open(page);
  if (on) await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, 'editor.smartPaste': true };
  });
  await openNote(page, 'ops/paste.md', 'Intro');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
}

async function paste(page: Page, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+v');
}

const chip = (page: Page) => page.getByTestId('paste-chip');

test.describe('smart paste', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('off by default: a paste is just a paste', async ({ page, ws }) => {
    await setup(page, ws, false);
    await paste(page, '{"a":1}');
    await expect.poll(() => content(page)).toBe('Intro\n\n{"a":1}');
    await page.waitForTimeout(300);
    await expect(chip(page)).toHaveCount(0);
  });

  test('JSON → ```json; one Ctrl+Z restores the note; Esc keeps the plain paste', async ({ page, ws }) => {
    await setup(page, ws);
    await paste(page, '{"name":"web01","ports":[80,443]}');
    await expect(chip(page)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'paste-chip-dark.png') });
    await chip(page).getByRole('button', { name: 'JSON block' }).click();
    await expect.poll(() => content(page)).toBe('Intro\n\n```json\n{\n  "name": "web01",\n  "ports": [\n    80,\n    443\n  ]\n}\n```');
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page)).toBe('Intro\n\n');
    await paste(page, '[1,2]');
    await expect(chip(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(chip(page)).toHaveCount(0);
    expect(await content(page)).toBe('Intro\n\n[1,2]');
    // Typing dismisses too.
    await paste(page, '[3]');
    await expect(chip(page)).toBeVisible();
    await page.keyboard.type('x');
    await expect(chip(page)).toHaveCount(0);
  });

  test('curl → formatted, or as template (values into variables.md, token into the vault)', async ({ page, ws }) => {
    await setup(page, ws);
    await paste(page, `curl -X GET 'https://api.corp.local/v1/users/12345' -H 'Authorization: Bearer eyTok3n'`);
    await chip(page).getByRole('button', { name: 'curl as template' }).click();
    await expect.poll(() => content(page)).toContain("curl \\\n  -X GET \\\n  'https://{{host}}/v1/users/{{id}}' \\\n  -H 'Authorization: Bearer {{token}}'");
    await expect.poll(() => fs.existsSync(path.join(ws.root, 'variables.md'))).toBe(true);
    const vars = fs.readFileSync(path.join(ws.root, 'variables.md'), 'utf8');
    expect(vars).toContain('host: api.corp.local');
    expect(vars).toMatch(/id: "?12345"?\n/);
    expect(vars).toMatch(/secrets: \[token\]/);
    expect(vars).not.toContain('eyTok3n');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator('.cm-content .se-var[data-var="token"]')).toHaveText('••••');
    await expect(page.locator('.cm-content .se-var[data-var="host"]')).toHaveText('api.corp.local');
    // And the plain formatted variant.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await paste(page, 'curl https://example.com -H "X: 1"');
    await chip(page).getByRole('button', { name: 'Formatted curl' }).click();
    await expect.poll(() => content(page)).toContain('```bash\ncurl \\\n  https://example.com \\\n  -H "X: 1"\n```');
  });

  test('CSV / TSV → table, SQL → formatted, stack trace → log block with Ctrl+click file:line', async ({ page, ws }) => {
    await setup(page, ws);
    await paste(page, 'host\tip\nDC01\t10.0.0.10');
    await chip(page).getByRole('button', { name: 'Markdown table' }).click();
    await expect.poll(() => content(page)).toBe('Intro\n\n| host | ip |\n| --- | --- |\n| DC01 | 10.0.0.10 |');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await paste(page, 'select id,name from users where id=1');
    await chip(page).getByRole('button', { name: 'Formatted SQL' }).click();
    await expect.poll(() => content(page)).toContain('```sql\nSELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1\n```');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await paste(page, 'Error: boom\n    at run (code/app.ts:3:5)\n    at main (code/app.ts:1:1)');
    await chip(page).getByRole('button', { name: /Log block/ }).click();
    await expect.poll(() => content(page)).toContain('```log\nError: boom\n    at run (code/app.ts:3:5)');
    const link = page.locator('.se-log-link').first();
    await expect(link).toHaveAttribute('data-file', 'code/app.ts');
    await link.click({ modifiers: ['Control'] });
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('code/app.ts');
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(2);
  });

  test('recognized content only: prose gets no chip, and code files get none at all', async ({ page, ws }) => {
    await setup(page, ws);
    await paste(page, 'the migration runs after the deploy, then we check the dashboards\n');
    await expect.poll(() => content(page)).toContain('the migration runs after the deploy');
    await page.waitForTimeout(400); // the chip would have appeared by now (the other tests show it in ms)
    await expect(chip(page)).toHaveCount(0);
    // The same JSON does get a chip in a note. In a code file smart paste is not offered at all:
    // its extension (../variables/cm.ts) is part of the Markdown note extensions only.
    await ws.write('ops/data.json', '{\n  "name": "web01"\n}\n');
    await openNote(page, 'ops/data.json', 'web01');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await paste(page, '{"name":"web01","ports":[80,443]}');
    await expect.poll(() => content(page)).toContain('"ports":[80,443]');
    await page.waitForTimeout(400);
    await expect(chip(page)).toHaveCount(0);
    // And inside a code block of a note: only a secret is offered there, re-fencing JSON makes no sense.
    await openNote(page, 'ops/paste.md', 'Intro');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await paste(page, '```json\n\n```');
    await cursorTo(page, { after: '```json\n' });
    await paste(page, '{"name":"web01"}');
    await expect.poll(() => content(page)).toContain('"name":"web01"');
    await page.waitForTimeout(400);
    await expect(chip(page)).toHaveCount(0);
  });

  test('VS Code clipboard → fenced with its language; secret → replaced by {{variable}}', async ({ page, ws }) => {
    await setup(page, ws);
    // VS Code's own clipboard type can't be written by a page: replay a real paste event carrying it.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'const a = 1;\nconst b = 2;');
      dt.setData('vscode-editor-data', JSON.stringify({ version: 1, mode: 'typescript' }));
      const view = (window as any).__secEdit.editor.getView();
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await chip(page).getByRole('button', { name: 'Code block (typescript)' }).click();
    await expect.poll(() => content(page)).toBe('Intro\n\n```typescript\nconst a = 1;\nconst b = 2;\n```');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('token: ');
    await paste(page, 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    await expect(chip(page).locator('.is-warn')).toContainText('Looks like a secret');
    await page.screenshot({ path: path.join(SHOTS, 'paste-secret-dark.png') });
    await chip(page).locator('.is-warn').click();
    await expect.poll(() => content(page)).toContain('token: {{github_token}}');
    expect(await content(page)).not.toContain('ghp_');
    await expect.poll(() => fs.existsSync(path.join(ws.root, 'variables.md'))).toBe(true);
    expect(fs.readFileSync(path.join(ws.root, 'variables.md'), 'utf8')).not.toContain('ghp_');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.keyboard.press('Enter');
    await paste(page, '{"x":true}');
    await expect(chip(page)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'paste-chip-light.png') });
  });
});
