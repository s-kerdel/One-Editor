// Go to definition (browser mode): Ctrl+click across files (PHP via `use`, into vendor/ via PSR-4; JS via
// import), F12, the picker for several hits, Alt+← back (also after a short same-file jump), Shift+F12 →
// Find in files, Ctrl+T lists code symbols, the underline while Ctrl is held, and Markdown links unchanged.
// The workspace is built per test in the worker's temp copy (gd/); the shared fixtures stay untouched.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { openNote } from './editor-helpers';

const FILES: Record<string, string> = {
  'gd/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
  'gd/vendor/composer/autoload_psr4.php': "<?php\n$vendorDir = dirname(__DIR__);\n$baseDir = dirname($vendorDir);\n\nreturn array(\n    'Acme\\\\Lib\\\\' => array($vendorDir . '/acme/lib/src'),\n);\n",
  'gd/vendor/acme/lib/src/Collection.php': '<?php\nnamespace Acme\\Lib;\n\nclass Collection\n{\n}\n',
  'gd/app/Models/User.php': '<?php\nnamespace App\\Models;\n\nclass User\n{\n    public function save() {}\n}\n',
  'gd/app/Models/Post.php': '<?php\nnamespace App\\Models;\n\nclass Post\n{\n    public function save() {}\n}\n',
  'gd/app/Http/Controller.php': `<?php
namespace App\\Http;

use App\\Models\\User;
use Acme\\Lib\\Collection;

class Controller
{
    public function show($x)
    {
        $u = new User();
        $c = new Collection();
        $x->save();
        $this->helper();
    }

    private function helper() {}
}
`,
  'gd/web/util.ts': 'export function formatMoney(n: number) {\n  return n;\n}\n',
  'gd/web/main.ts': "import { formatMoney } from './util';\n\nconsole.log(formatMoney(1));\n",
  'gd/notes/links.md': '# Links\n\nSee [the target](target.md) now.\n',
  'gd/notes/target.md': '# Target\n',
};

test.beforeEach(async ({ page, ws }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(ws.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws.root, rel), text);
  }
});

const state = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).__secEdit;
    const c = app.editor.getCursor();
    return `${app.activePath.value}:${c.line}`;
  });

async function boot(page: Page, ws: { open(p: Page): Promise<void> }) {
  await ws.open(page);
  // Symbol index (search chunk on idle) and the navigation recorder must be in.
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && !!(window as any).__secEditNav, null, { timeout: 30000 });
}

/** Viewport point inside the `n`-th occurrence of `needle` in the open document. */
async function pointAt(page: Page, needle: string, n = 0) {
  return page.evaluate(
    ([w, k]) => {
      const view = (window as any).__secEdit.editor.getView();
      const doc: string = view.state.doc.toString();
      let at = -1;
      for (let i = 0; i <= k; i++) at = doc.indexOf(w, at + 1);
      view.dispatch({ effects: [], scrollIntoView: true });
      const c = view.coordsAtPos(at + 1);
      return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
    },
    [needle, n] as const,
  );
}

async function ctrlClick(page: Page, needle: string, n = 0) {
  const p = await pointAt(page, needle, n);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
}

async function cursorIn(page: Page, needle: string, n = 0) {
  await page.evaluate(
    ([w, k]) => {
      const view = (window as any).__secEdit.editor.getView();
      const doc: string = view.state.doc.toString();
      let at = -1;
      for (let i = 0; i <= k; i++) at = doc.indexOf(w, at + 1);
      view.dispatch({ selection: { anchor: at + 1 }, scrollIntoView: true });
      view.focus();
    },
    [needle, n] as const,
  );
}

test('PHP: Ctrl+click through `use` → the class; into vendor/ via PSR-4; Alt+← comes back', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/app/Http/Controller.php', 'class Controller');
  await ctrlClick(page, 'User()');
  await expect.poll(() => state(page)).toBe('gd/app/Models/User.php:3');
  await page.waitForTimeout(450); // longer than the nav coalescing window
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => state(page)).toBe('gd/app/Http/Controller.php:10');

  // vendor/ is excluded from the tree and never indexed: PSR-4 from autoload_psr4.php finds it.
  await ctrlClick(page, 'Collection()');
  await expect.poll(() => state(page)).toBe('gd/vendor/acme/lib/src/Collection.php:3');

  // Those reads must not put vendor/ into the index: not after the tab closes, not after a rebuild.
  await page.evaluate(() => (window as any).__secEdit.closeTab('gd/vendor/acme/lib/src/Collection.php'));
  await page.evaluate(() => (window as any).__secEditSearch.reindex());
  await page.waitForFunction(() => (window as any).__secEditSearch.status.value === 'ready', null, { timeout: 20000 });
  const leaked = await page.evaluate(async () => {
    const c = (window as any).__secEditSearch;
    const r = await c.search('Collection', {}, 'test');
    const h = await c.headings({ query: 'Collection', symbols: true });
    const d = await c.definitions({ names: ['Collection'] });
    return [...r.results.map((x: any) => x.path), ...h.map((x: any) => x.path), ...d.map((x: any) => x.path)].filter((p: string) => p.includes('vendor/'));
  });
  expect(leaked).toEqual([]);
});

test('JS: Ctrl+click on an imported name → its definition; F12 at the cursor does the same', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/web/main.ts', 'console.log');
  await ctrlClick(page, 'formatMoney(1)');
  await expect.poll(() => state(page)).toBe('gd/web/util.ts:0');

  await openNote(page, 'gd/web/main.ts', 'console.log');
  await cursorIn(page, 'formatMoney(1)');
  await page.keyboard.press('F12');
  await expect.poll(() => state(page)).toBe('gd/web/util.ts:0');
});

test('several definitions → a picker (keyboard); a short same-file jump still goes back', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/app/Http/Controller.php', 'class Controller');
  await cursorIn(page, 'save()');
  await page.keyboard.press('F12');
  const picker = page.getByTestId('definition-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByLabel('Filter definitions')).toBeFocused();
  await expect(picker.locator('.se-defpick-row')).toHaveCount(2);
  await expect(picker.locator('.se-defpick-row').first()).toContainText('gd/app/Models/Post.php:6');
  await expect(picker.locator('.se-defpick-row').nth(1)).toContainText('public function save() {}');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect.poll(() => state(page)).toBe('gd/app/Models/User.php:5');

  // The mouse works too; typing filters the rows.
  await openNote(page, 'gd/app/Http/Controller.php', 'class Controller');
  await cursorIn(page, 'save()');
  await page.keyboard.press('F12');
  await expect(picker).toBeVisible();
  await expect(picker.getByLabel('Filter definitions')).toBeFocused();
  await page.keyboard.type('post');
  await expect(picker.locator('.se-defpick-row')).toHaveCount(1);
  await picker.locator('.se-defpick-row').first().click();
  await expect.poll(() => state(page)).toBe('gd/app/Models/Post.php:5');

  // `$this->helper()` → three lines down: below the 10-line rule, recorded because the jump is marked.
  await openNote(page, 'gd/app/Http/Controller.php', 'class Controller');
  await cursorIn(page, 'helper();');
  await page.waitForTimeout(450);
  await page.keyboard.press('F12');
  await expect.poll(() => state(page)).toBe('gd/app/Http/Controller.php:16');
  await page.waitForTimeout(450);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => state(page)).toBe('gd/app/Http/Controller.php:13');
});

test('Shift+F12 opens Find in files: whole word, exact case, the language family', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/web/main.ts', 'console.log');
  await cursorIn(page, 'formatMoney(1)');
  await page.keyboard.press('Shift+F12');
  const input = page.getByLabel('Search query');
  await expect(input).toHaveValue(/^"formatMoney" lang:[a-z,]*typescript[a-z,]* case:yes$/);
  await expect(page.getByRole('button', { name: 'Match whole word' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.se-sr-match[data-path="gd/web/util.ts"]')).toHaveCount(1);
  await expect(page.locator('.se-sr-match[data-path="gd/web/main.ts"]')).toHaveCount(2);
});

test('Ctrl+T lists code symbols with kind and path', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/notes/target.md', 'Target');
  await page.keyboard.press('Control+t');
  await page.keyboard.type('formatMon');
  const item = page.locator('.se-pal-item', { hasText: 'formatMoney' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('function');
  await expect(item).toContainText('gd/web/util.ts');
  await page.keyboard.press('Enter');
  await expect.poll(() => state(page)).toBe('gd/web/util.ts:0');
});

test('while Ctrl is held the name under the pointer is underlined (no lookup)', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/web/main.ts', 'console.log');
  const p = await pointAt(page, 'formatMoney(1)');
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Control');
  await page.mouse.move(p.x + 2, p.y);
  await expect(page.locator('.cm-content .se-def-link')).toHaveText('formatMoney');
  await page.keyboard.up('Control');
  await expect(page.locator('.cm-content .se-def-link')).toHaveCount(0);
});

test('Markdown: Ctrl+click on a link still follows the link', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/notes/links.md', 'See');
  const link = page.locator('.cm-content .se-mdlink', { hasText: 'the target' });
  await expect(link).toHaveCount(1);
  await link.click({ modifiers: ['Control'] });
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('gd/notes/target.md');
  await expect(page.locator('.se-toast', { hasText: 'definition' })).toHaveCount(0);
});

test('nothing found → a toast with "Search in files"; the right-click menu offers both actions', async ({ page, ws }) => {
  await boot(page, ws);
  await openNote(page, 'gd/app/Http/Controller.php', 'class Controller');
  await ctrlClick(page, 'x)'); // the parameter `$x`: a variable, no definition
  const toast = page.locator('.se-toast', { hasText: 'No definition found for x' });
  await expect(toast).toHaveCount(1);
  await toast.getByRole('button', { name: 'Search in files' }).click();
  await expect(page.getByLabel('Search query')).toHaveValue(/^"x" lang:/);

  await openNote(page, 'gd/web/main.ts', 'console.log');
  const p = await pointAt(page, 'formatMoney(1)');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Find usages/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /Go to definition/ }).click();
  await expect.poll(() => state(page)).toBe('gd/web/util.ts:0');
});
