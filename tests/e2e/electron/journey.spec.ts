// QA journey 8 — Electron smoke: launch with a folder + a file, write a command, save, find it again,
// relaunch and find everything where it was left.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';

const CMD = 'kubectl rollout undo deployment/web --to-revision=3';

test('folder + file from the CLI → edit → Ctrl+S → search the command → relaunch restores', async ({ el }) => {
  const file = path.join(el.ws, 'notes', 'kubernetes.md');
  const first = await el.launch([el.ws, file]);
  const page = first.page;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The folder is the workspace, the file is open in it (not its own parent folder).
  await expect(page.getByTestId('workspace-name')).toHaveText('workspace');
  await expect(page.locator('.se-tab.active')).toContainText('kubernetes.md');
  expect(await page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('notes/kubernetes.md');
  await expect(page.locator('.cm-content')).toContainText('Kubernetes cheatsheet');

  // Write a new command into a fenced block and save explicitly.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\n```bash\n' + CMD);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fsp.readFile(file, 'utf8')).toContain('```bash\n' + CMD + '\n```');

  // Find it through the search panel; the hit is a bash code hit and opens at the right line.
  await page.keyboard.press('Control+Shift+f');
  const input = page.getByLabel('Search query');
  await expect(input).toBeFocused();
  await input.fill('--to-revision=3');
  const row = page.locator('.se-sr-match[data-path="notes/kubernetes.md"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.se-badge-code')).toHaveText('bash');
  await input.fill(CMD);
  await expect(row).toHaveCount(1);
  await expect(row.locator('mark.se-hit')).toHaveText(CMD);
  await input.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = (window as any).__secEdit.editor.getView();
        return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) as string;
      }),
    )
    .toBe(CMD);
  expect(await page.evaluate(() => (window as any).__secEditSearch.mode.value)).toBe('worker');
  expect(errors).toEqual([]);

  // Relaunch without arguments: same folder, same tab, the saved text is there.
  await page.waitForTimeout(500); // session save is debounced (no observable state in the page)
  await first.app.close();
  const second = await el.launch([]);
  expect(await second.page.evaluate(() => (window as any).__secEdit.workspace.value.name)).toBe('workspace');
  await expect(second.page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'search'); // the panel you left open
  await expect(second.page.locator('.se-tab.active')).toContainText('kubernetes.md');
  await expect(second.page.locator('.cm-content')).toContainText('--to-revision=3');
  console.log(`[journey electron] ready in ${first.readyMs} ms, relaunch ${second.readyMs} ms`);
});
