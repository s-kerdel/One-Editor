// {{variables}} secrets in the desktop app: set through a chip → stored encrypted (safeStorage) in the
// user-data vault, never in the note or variables.md; copy gets the real value, display stays masked,
// and the value survives a restart.
import { test, expect, fs, path } from './fixture';
import type { Page } from '@playwright/test';

const VARS = '# Vars\n\n```yaml\nvars:\n  host: db01.corp.local\nsecrets: [db_pass]\n```\n';
const NOTE = '# DB\n\nPassword {{db_pass}}\n\n```bash\nmysql -h {{host}} -p{{db_pass}}\n```\n';
const SECRET = 'S3cr3t-Vault-Value!';

function seed(ws: string) {
  fs.mkdirSync(path.join(ws, 'project-a'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'project-a/variables.md'), VARS);
  fs.writeFileSync(path.join(ws, 'project-a/db.md'), NOTE);
}

async function openNote(page: Page, p: string) {
  await page.waitForFunction((f) => (window as any).__secEdit?.files.value.includes(f), p);
  await page.evaluate((f) => (window as any).__secEdit.openFile(f), p);
  await expect(page.locator('.cm-content .se-var').first()).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('secrets live in the encrypted vault, never in a file; copy gets the value; it survives a restart', async ({ el }) => {
  seed(el.ws);
  let { app, page } = await el.launch();
  expect(await page.evaluate(() => (window as any).secEditBridge.vault.status())).toMatchObject({ ok: true, result: { available: true } });
  await openNote(page, 'project-a/db.md');
  const chip = page.locator('.cm-content .se-var[data-var="db_pass"]').first();
  await expect(chip).toHaveText('🔒 db_pass');
  await chip.click();
  const editor = page.getByTestId('var-editor');
  await expect(editor.getByLabel('Value', { exact: true })).toHaveAttribute('type', 'password');
  await editor.getByLabel('Value', { exact: true }).fill(SECRET);
  await editor.getByLabel('Value', { exact: true }).press('Enter');
  await expect(chip).toHaveText('••••');

  // On disk: ciphertext in user data; nothing in the workspace.
  const vaultFile = path.join(el.userData, 'vault.json');
  await expect.poll(() => fs.existsSync(vaultFile)).toBe(true);
  const raw = fs.readFileSync(vaultFile, 'utf8');
  expect(raw).not.toContain(SECRET);
  expect(JSON.parse(raw).entries).toBeTruthy();
  expect(fs.readFileSync(path.join(el.ws, 'project-a/variables.md'), 'utf8')).toBe(VARS);
  expect(fs.readFileSync(path.join(el.ws, 'project-a/db.md'), 'utf8')).toBe(NOTE);

  // Copy resolves the secret for real; the preview / export path masks it.
  await page.locator('.se-cb-header .se-cb-copy').first().click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`mysql -h db01.corp.local -p${SECRET}`);
  const exported = await page.evaluate(() => (window as any).__secEdit.variables.renderHook('project-a/db.md', { export: true })('pw {{db_pass}}', null));
  expect(exported).toBe('pw ••••');
  // The renderer never logs it.
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));

  await app.close();
  ({ app, page } = await el.launch());
  page.on('console', (m) => logs.push(m.text()));
  await openNote(page, 'project-a/db.md');
  await expect(page.locator('.cm-content .se-var[data-var="db_pass"]').first()).toHaveText('••••');
  await page.locator('.se-cb-header .se-cb-copy').first().click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`mysql -h db01.corp.local -p${SECRET}`);
  // Alt + hover reveals it (fetched from the vault on demand).
  const chip2 = page.locator('.cm-content .se-var[data-var="db_pass"]').first();
  await chip2.hover();
  await page.keyboard.down('Alt');
  await expect(chip2).toHaveText(SECRET);
  await page.keyboard.up('Alt');
  await expect(chip2).toHaveText('••••');
  expect(logs.join('\n')).not.toContain(SECRET);

  // An untrusted frame can't read it: the IPC checks the sender (here: a direct call from the page works,
  // a bad key is refused with a message that never echoes the value).
  const bad = await page.evaluate(() => (window as any).secEditBridge.vault.set('bad\nkey', 'zzz'));
  expect(bad).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
});
