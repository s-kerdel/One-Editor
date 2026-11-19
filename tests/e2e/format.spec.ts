import { test, expect } from './harness';
import type { Page } from '@playwright/test';

// Helpers lean on stable surfaces only: window.__secEdit (app), .cm-content, role=dialog palette.
const content = (page: Page) => page.evaluate(() => (window as any).__secEdit.editor.getContent() as string);
const toasts = (page: Page) => page.evaluate(() => ((window as any).__secEdit.toasts.value as Array<{ message: string }>).map((t) => t.message));

async function openFile(page: Page, path: string, marker: string) {
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), path);
  await expect(page.locator('.cm-content')).toContainText(marker);
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
}

async function palette(page: Page, query: string) {
  await page.keyboard.press('Control+Shift+p');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  // The palette may or may not pre-fill ">" for command mode; typing it twice is harmless either way.
  if (!(await input.inputValue()).startsWith('>')) await page.keyboard.type('>');
  await page.keyboard.type(query);
  await expect(page.getByRole('dialog')).toContainText(/format/i);
  await page.keyboard.press('Enter');
}

const FORMATTED_PHP = `<?php
namespace App\\Http\\Controllers;
use App\\Models\\User;
class UserController extends Controller
{
    public function index()
    {
        $users = User::query()->where('active', true)->orderBy('name')->get();
        return view('users.index', ['users' => $users]);
    }
    public function show(int $id)
    {
        return User::findOrFail($id);
    }
}
`;

test('Shift+Alt+F formats a PHP file; Ctrl+S writes the formatted file', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await ws.open(page);
  await openFile(page, 'code/UserController.php', 'UserController');
  // Prettier must not be part of startup or of merely opening a file.
  expect(requested.filter((u) => /\/standalone-[\w-]+\.js/.test(u))).toEqual([]);

  await page.locator('.cm-content').click();
  await page.keyboard.press('Shift+Alt+f');
  await expect.poll(() => content(page), { timeout: 20000 }).toBe(FORMATTED_PHP);
  await expect(page.locator('.cm-content')).toContainText('public function show(int $id)');
  expect(requested.some((u) => /\/standalone-[\w-]+\.js/.test(u))).toBe(true);

  await page.keyboard.press('Control+s');
  await expect.poll(() => ws.read('code/UserController.php')).toBe(FORMATTED_PHP);

  // Formatting again is a no-op.
  await page.keyboard.press('Shift+Alt+f');
  await page.waitForTimeout(500);
  expect(await content(page)).toBe(FORMATTED_PHP);
  expect(errors).toEqual([]);
});

test('"Format all code blocks in note" via the command palette', async ({ page, ws }) => {
  await ws.write(
    'notes/format-me.md',
    '# Queries\n\nSome *prose*   stays as typed.\n\n```sql\nselect id,name from users where active=1 order by name\n```\n\n- item\n\n  ```json\n  {"a":1,"b":[1,2]}\n  ```\n\n```python\ndef  keep( ):  pass\n```\n',
  );
  await ws.open(page);
  await openFile(page, 'notes/format-me.md', 'Queries');
  await palette(page, 'Format all code blocks');
  await expect
    .poll(() => content(page), { timeout: 20000 })
    .toBe(
      '# Queries\n\nSome *prose*   stays as typed.\n\n```sql\nSELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  active = 1\nORDER BY\n  name\n```\n\n- item\n\n  ```json\n  { "a": 1, "b": [1, 2] }\n  ```\n\n```python\ndef  keep( ):  pass\n```\n',
    );
  await expect(page.locator('.cm-content')).toContainText('SELECT');
});

test('every lazy formatter loads in the real worker bundle (php, xml, shell, css, yaml, ts, html, graphql)', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const blocks: Array<[string, string, string]> = [
    ['php', '$a=array(1,2);', '$a = [1, 2];'],
    ['xml', '<a><b x="1"   y="2">t</b><c/></a>', '<a>\n  <b x="1" y="2">t</b>\n  <c />\n</a>'],
    ['bash', 'if [ -f x ];then\necho hi   ;fi', 'if [ -f x ]; then\n  echo hi\nfi'],
    ['css', 'a{color:red}', 'a {\n  color: red;\n}'],
    ['yaml', 'a:    1', 'a: 1'],
    ['ts', 'const a:number=1', 'const a: number = 1;'],
    ['html', '<div><p>x</p></div>', '<div><p>x</p></div>'],
    ['graphql', 'query{a}', 'query {\n  a\n}'],
    ['vue', '<template><p>{{a}}</p></template>', '<template>\n  <p>{{ a }}</p>\n</template>'],
    ['pgsql', 'select a::int from t', 'SELECT\n  a::int\nFROM\n  t'],
  ];
  const note = (pick: 1 | 2) => '# All\n\n' + blocks.map((b) => '```' + b[0] + '\n' + b[pick] + '\n```\n').join('\n');
  await ws.write('notes/all-langs.md', note(1));
  await ws.open(page);
  await openFile(page, 'notes/all-langs.md', 'All');
  await page.evaluate(() => (window as any).__secEditFormat.formatCodeBlocksInNote());
  await expect.poll(() => content(page), { timeout: 30000 }).toBe(note(2));
  expect((await toasts(page)).join('|')).not.toMatch(/Skipped|failed|error/i);
  expect(errors).toEqual([]);
});

test('Format document on a note keeps Obsidian syntax and formats blocks', async ({ page, ws }) => {
  await ws.write('notes/obsidian.md', '# T\nSee [[Other Note|alias]] and ![[img.png|100]] %%hidden *x*%%\n* [ ] task ^id1\n\n| a | b |\n|---|---|\n| [[x|y]] | 1 |\n\n> [!note] Title\n> body ==hl== #tag\n\n```json\n{"a":1}\n```\n');
  await ws.open(page);
  await openFile(page, 'notes/obsidian.md', 'task'); // live preview renders [[Other Note|alias]] as "alias"
  await page.keyboard.press('Shift+Alt+f');
  await expect
    .poll(() => content(page), { timeout: 20000 })
    .toBe('# T\n\nSee [[Other Note|alias]] and ![[img.png|100]] %%hidden *x*%%\n\n- [ ] task ^id1\n\n| a       | b   |\n| ------- | --- |\n| [[x|y]] | 1   |\n\n> [!note] Title\n> body ==hl== #tag\n\n```json\n{ "a": 1 }\n```\n');
});

test('Ctrl+Alt+F formats only the code block at the cursor', async ({ page, ws }) => {
  await ws.write('notes/two-blocks.md', '# Two\n\n```json\n{"first":1}\n```\n\ntext\n\n```json\n{"second":2}\n```\n');
  await ws.open(page);
  await openFile(page, 'notes/two-blocks.md', 'Two');
  await page.evaluate(() => (window as any).__secEdit.editor.reveal({ line: 9, col: 3 }));
  await page.keyboard.press('Control+Alt+f');
  await expect.poll(() => content(page), { timeout: 20000 }).toBe('# Two\n\n```json\n{"first":1}\n```\n\ntext\n\n```json\n{ "second": 2 }\n```\n');
});

test('syntax errors toast with line:col and leave the document untouched', async ({ page, ws }) => {
  const broken = '<?php\nclass A {\n  function x( { }\n}\n';
  await ws.write('code/Broken.php', broken);
  await ws.open(page);
  await openFile(page, 'code/Broken.php', 'class A');
  await page.keyboard.press('Shift+Alt+f');
  await expect.poll(() => toasts(page), { timeout: 20000 }).toContainEqual(expect.stringMatching(/^PHP syntax error at 3:15: /));
  expect(await content(page)).toBe(broken);
  await expect(page.getByText(/PHP syntax error at 3:15/)).toBeVisible();
});

test('format on save: explicit save formats, autosave does not; .prettierrc is respected', async ({ page, ws }) => {
  await ws.write('.prettierrc', '{ "semi": false, "singleQuote": true }');
  await ws.write('code/save-me.ts', 'const a = {b:"x"}\n');
  await ws.open(page);
  await openFile(page, 'code/save-me.ts', 'const a');
  await palette(page, 'Toggle format on save');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.settings.value.formatOnSave)).toBe(true);

  // Typing + autosave must write the text as typed (no formatting behind the user's back).
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('const  typed=1');
  if (await page.evaluate(() => (window as any).__secEdit.settings.value.autosave)) {
    await expect.poll(() => ws.read('code/save-me.ts'), { timeout: 10000 }).toContain('const  typed=1');
    expect(await ws.read('code/save-me.ts')).toContain('{b:"x"}');
  }

  await page.keyboard.press('Control+s');
  const expected = "const a = { b: 'x' }\nconst typed = 1\n";
  await expect.poll(() => ws.read('code/save-me.ts'), { timeout: 20000 }).toBe(expected);
  expect(await content(page)).toBe(expected);

  // A file with a syntax error still saves (unformatted) and tells the user why.
  await page.keyboard.type('\nconst = ;');
  await page.keyboard.press('Control+s');
  await expect.poll(() => ws.read('code/save-me.ts'), { timeout: 20000 }).toContain('const = ;');
  await expect.poll(() => toasts(page)).toContainEqual(expect.stringMatching(/^Saved without formatting — TypeScript syntax error at \d+:\d+/));
});

test('formatting keeps the cursor on the same token and is a single undo step', async ({ page, ws }) => {
  await ws.open(page);
  await openFile(page, 'code/UserController.php', 'UserController');
  const original = await content(page);
  const caps = await page.evaluate(() => {
    const ed = (window as any).__secEdit.editor;
    return { apply: !!ed.applyChanges, offset: !!ed.getCursorOffset };
  });
  // Needs the editor's minimal-change API (owned by the editor agent); without it we fall back to setContent.
  test.skip(!caps.apply || !caps.offset, 'editor.applyChanges/getCursorOffset not available yet');
  const line = original.split('\n').findIndex((l) => l.includes('orderBy'));
  const col = original.split('\n')[line].indexOf('orderBy');
  await page.evaluate(([l, c]) => (window as any).__secEdit.editor.reveal({ line: l, col: c }), [line, col]);
  await page.keyboard.press('Shift+Alt+f');
  await expect.poll(() => content(page), { timeout: 20000 }).toBe(FORMATTED_PHP);
  const at = await page.evaluate(() => (window as any).__secEdit.editor.getCursorOffset() as number);
  expect(FORMATTED_PHP.slice(at, at + 7)).toBe('orderBy');
  await page.locator('.cm-content').press('Control+z');
  await expect.poll(() => content(page)).toBe(original);
});
