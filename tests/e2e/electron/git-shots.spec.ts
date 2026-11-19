// Screenshots of git in the real Electron window (shelf + classic, dark + light): tree marks + change
// bars with the peek open, the diff view, the Source control pane. Only with SEC_EDIT_GIT_SHOTS=<dir>.
import fsp from 'node:fs/promises';
import { test, expect, fs, path } from './fixture';
import { git, initRepo, isolateGit } from '../git-helpers';

const OUT = process.env.SEC_EDIT_GIT_SHOTS;
isolateGit();

for (const style of ['shelf', 'classic'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`git screenshots: ${style} ${theme}`, async ({ el }) => {
      test.skip(!OUT, 'set SEC_EDIT_GIT_SHOTS=<dir> to write screenshots');
      initRepo(el.ws);
      fs.appendFileSync(path.join(el.ws, 'README.md'), '\nA line added since the last commit.\n');
      git(el.ws, 'commit', '-qam', 'Polish the readme');
      const app = fs.readFileSync(path.join(el.ws, 'code/app.ts'), 'utf8').split('\n');
      app[1] = `${app[1]} // tweaked`;
      app.splice(4, 0, 'const added = true;', 'const another = 42;');
      app.splice(9, 1);
      fs.writeFileSync(path.join(el.ws, 'code/app.ts'), app.join('\n'));
      fs.writeFileSync(path.join(el.ws, 'notes/idea.md'), '# New idea\n');
      fs.appendFileSync(path.join(el.ws, 'notes/kubernetes.md'), '\nstaged edit\n');
      git(el.ws, 'add', 'notes/kubernetes.md');
      for (const b of ['feature/search-ui', 'fix/crlf-saves', 'release/1.2']) git(el.ws, 'branch', b);
      await fsp.mkdir(el.userData, { recursive: true });
      await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ sidebarStyle: style, theme }));
      const { app: eapp, page } = await el.launch([el.ws], { env: { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!, GIT_CONFIG_NOSYSTEM: '1' } });
      await eapp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
      await page.waitForFunction(() => (window as any).__secEditGit?.status.value?.ok === true, undefined, { timeout: 20000 });
      const dir = path.join(OUT!, `${style}-${theme}`);
      await fsp.mkdir(dir, { recursive: true });

      // 1. tree marks + change bars, peek open
      await page.locator('.se-tree-row[data-path="code"]').click();
      await page.locator('.se-tree-row[data-path="notes"]').click();
      await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
      await expect(page.locator('.se-git-bar').first()).toBeVisible();
      await page.locator('.se-git-gutter .cm-gutterElement:has(.se-git-bar)').first().click();
      await expect(page.locator('.se-git-peek')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, '1-tree-gutter.png') });

      // 2. diff view, side by side
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Shift+P');
      await page.keyboard.type('Diff with last commit');
      await page.keyboard.press('Enter');
      await page.locator('.se-git-diff').getByRole('radio', { name: 'Side by side' }).click();
      await expect(page.locator('.cm-mergeView')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, '2-diff.png') });
      await page.keyboard.press('Escape');

      // 3. Source control pane with history open
      await page.keyboard.press('Control+Shift+G');
      const scm = page.getByTestId('scm');
      await expect(scm).toBeVisible();
      await scm.getByLabel('Commit message').fill('Tweak the app');
      await scm.locator('[data-section="branches"] .se-scm-toggle').click();
      await expect(scm.locator('.se-scm-brow').first()).toBeVisible();
      await scm.locator('[data-section="history"] .se-scm-toggle').click();
      await scm.locator('.se-scm-crow').first().click();
      await expect(scm.locator('.se-scm-cfiles .se-scm-row').first()).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, '3-pane.png') });

      // 4. Compare text: a selection vs another file (previous selection), side by side
      fs.writeFileSync(path.join(el.ws, 'code/app-v2.ts'), 'export function greet(name: string) {\n  return `Hi, ${name}!`;\n}\nconst items = [1, 2, 3].map((x) => x * 2);\nexport const total = items.length;\n');
      fs.writeFileSync(path.join(el.ws, 'code/app-v1.ts'), 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\nconst items = [1, 2, 3].map((x) => x * 2);\n');
      await page.evaluate(() => (window as any).__secEdit.openFile('code/app-v1.ts'));
      await expect(page.locator('.cm-content')).toContainText('Hello');
      await page.locator('.cm-content').click({ button: 'right', position: { x: 40, y: 8 } });
      await page.locator('.se-menu-item', { hasText: 'Select Text for Compare' }).click();
      await page.evaluate(() => (window as any).__secEdit.openFile('code/app-v2.ts'));
      await expect(page.locator('.cm-content')).toContainText('total');
      await page.locator('.cm-content').click({ button: 'right', position: { x: 40, y: 8 } });
      await page.locator('.se-menu-item', { hasText: 'Compare Text with Previous Selection' }).click();
      await page.locator('.se-git-diff').getByRole('radio', { name: 'Side by side' }).click();
      await expect(page.locator('.cm-mergeView')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, '4-compare.png') });
      await page.keyboard.press('Escape');
    });
  }
}
