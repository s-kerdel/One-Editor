import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness';

const SHOTS = process.env.SEC_EDIT_SHOTS || '';
const P = '.se-preview';

async function setMode(page: Page, mode: 'live' | 'source' | 'split' | 'preview') {
  await page.evaluate(async (m) => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings({ viewMode: m });
    app.editor?.setViewMode(m);
    app.events.emit('settings:changed', app.settings.value);
  }, mode);
}
const openFile = (page: Page, p: string) => page.evaluate((x) => (window as any).__secEdit.openFile(x), p);
const settle = (page: Page) => page.evaluate(() => (window as any).__secEdit.preview.settle());
async function start(page: Page, ws: { open(p: Page): Promise<void> }, file: string, mode: 'split' | 'preview' = 'split') {
  await ws.open(page);
  await setMode(page, mode);
  await openFile(page, file);
  await expect(page.locator(`${P} .se-sec`).first()).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

const SHOWCASE = `---
title: Preview showcase
tags: [demo, preview]
aliases:
  - Kitchen sink
draft: false
---

# Preview showcase

A paragraph with **bold**, *italic*, ~~strike~~, ==highlight==, \`inline code\`, <kbd>Ctrl</kbd>+<kbd>K</kbd>, a [[README]] link,
an [[Missing note|unresolved link]], an [external link](https://example.com), #tag/nested and a footnote[^1]. %%hidden comment%%

## Callouts

> [!tip] Pro tip
> Callouts support **markdown** and \`code\`.
>
> > [!warning] Nested
> > Careful now.

> [!faq]- Folded question
> Hidden answer.

> [!danger] Danger
> [!bug] is red too.

## Tasks

- [ ] Open task
- [x] Done task
  - [ ] Nested task

## Table

| Language | Typing  | Year |
|:---------|:-------:|-----:|
| PHP      | dynamic | 1995 |
| Rust     | static  | 2010 |
| Python   | dynamic | 1991 |

## Code

\`\`\`php title="UserController.php"
<?php
final class UserController {
    public function show(int $id): Response {
        return $this->render('user', ['user' => User::find($id)]);
    }
}
\`\`\`

\`\`\`diff
@@ -1,3 +1,3 @@
 unchanged
-removed line
+added line
\`\`\`

\`\`\`ts showLineNumbers
export const answer: number = 42;
const greet = (name: string) => \`Hello \${name}\`;
\`\`\`

## Math

Euler: $e^{i\\pi} + 1 = 0$, but prices like $5 and $10 stay text.

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

## Diagram

\`\`\`mermaid
graph LR
  A[Markdown] --> B(Preview)
  B --> C{Looks good?}
  C -->|yes| D[Ship]
  C -->|no| A
\`\`\`

## Embed

![[kubernetes]]

> A plain blockquote for contrast.

---

[^1]: The footnote text.
`;

test('Daily notes: frontmatter, callout, table, KaTeX; checkbox click reaches the file on disk', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page, ws, 'notes/Daily notes.md');
  const pv = page.locator(P);
  await expect(pv.locator('h1')).toHaveText('Daily notes');
  await expect(pv.locator('.se-frontmatter tr')).toHaveCount(2);
  await expect(pv.locator('.se-frontmatter .se-tag')).toHaveText(['#journal', '#daily']);
  await expect(pv.locator('hr')).toHaveCount(0);
  await expect(pv.locator('.se-callout[data-callout="note"] .se-callout-title')).toHaveText('Callout title');
  await expect(pv.locator('.se-callout-content')).toContainText('Callouts render like Obsidian.');
  await expect(pv.locator('.se-table-wrap td')).toHaveText(['a', '1']);
  // KaTeX arrives lazily and replaces the TeX placeholder; `$this->render()` stays code.
  await expect(pv.locator('.se-math .katex')).toHaveCount(1);
  await expect(pv.locator('code', { hasText: '$this->render()' })).toBeVisible();
  // Lazy KaTeX stylesheet really applied (struts are inline-block only with the CSS).
  await expect.poll(() => pv.locator('.katex [class*="strut"]').first().evaluate((n) => getComputedStyle(n).display)).toBe('inline-block');

  const boxes = pv.locator('input.se-task');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await boxes.nth(0).click();
  await expect.poll(() => ws.read('notes/Daily notes.md')).toContain('- [x] Write the release notes');
  await expect(page.locator('.cm-content')).toContainText('[x] Write the release notes');
  await expect(pv.locator('input.se-task').nth(0)).toBeChecked();
  await pv.locator('input.se-task').nth(1).click();
  await expect.poll(() => ws.read('notes/Daily notes.md')).toContain('- [ ] Fix the `array_map` bug');
  expect((await ws.read('notes/Daily notes.md')).startsWith('---\ntitle: Daily notes')).toBe(true);
  expect(errors).toEqual([]);
});

test('README: Shiki highlighting, copy button, wikilink navigation, live update while typing', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await start(page, ws, 'README.md');
  const pv = page.locator(P);
  const code = pv.locator('.se-code[data-lang="shellscript"]');
  await expect(code.locator('.se-code-lang')).toHaveText('Shell');
  // Upgraded in place: coloured token spans with both theme colours.
  await expect(code).toHaveAttribute('data-hl', '1');
  const tokens = code.locator('code .line span[style*="--shiki-dark"]');
  expect(await tokens.count()).toBeGreaterThan(5);
  const colors = await tokens.evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).color))]);
  expect(colors.length).toBeGreaterThan(1);
  await expect(code.locator('code .line')).toHaveCount(3);

  await code.hover();
  await code.locator('.se-code-copy').click();
  await expect(code.locator('.se-code-copy')).toHaveClass(/is-copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('git push --force-with-lease origin main\nphp artisan migrate:fresh --seed\ndocker compose up -d');

  await expect(pv.locator('.se-tag')).toHaveText(['#tag/project', '#idea']);
  await expect(pv.locator('a.se-external')).toHaveAttribute('href', 'https://example.com');

  // Typing in the editor updates the preview.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nTyped ==live== text');
  await expect(pv.locator('mark')).toHaveText('live');
  // …without re-highlighting the untouched code block (same DOM node survives).
  await expect(code).toHaveAttribute('data-hl', '1');

  const link = pv.locator('a.se-wikilink', { hasText: 'Daily notes' });
  await expect(link).not.toHaveClass(/is-unresolved/);
  await link.click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('notes/Daily notes.md');
  await expect(pv.locator('h1')).toHaveText('Daily notes');
});

test('raw HTML is sanitized in the real DOM; links never navigate the app', async ({ page, ws }) => {
  await ws.write(
    'evil.md',
    '# Evil\n\n<script>window.__pwned = 1</script>\n\n<img src="nope.png" onerror="window.__pwned = 2">\n\n<a id="js" href="javascript:window.__pwned=3">js link</a>\n\n' +
      '<svg><script>window.__pwned = 4</script></svg>\n\n<iframe src="https://example.com"></iframe>\n\n<div style="position:fixed;inset:0;z-index:99999">overlay</div>\n\n[ext](https://example.com/page) [rel](notes/kubernetes.md)\n',
  );
  let dialogs = 0;
  page.on('dialog', (d) => (dialogs++, d.dismiss()));
  await start(page, ws, 'evil.md', 'preview');
  const pv = page.locator(P);
  await expect(pv.locator('h1')).toHaveText('Evil');
  await expect(pv.locator('script, iframe, [onerror], [style*="fixed"]')).toHaveCount(0);
  await pv.locator('a', { hasText: 'js link' }).click();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  expect(dialogs).toBe(0);

  // External links go through the backend, relative links open in the app.
  const url = page.url();
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    (window as any).__opened = [];
    app.backend.openExternal = async (u: string) => void (window as any).__opened.push(u);
  });
  await pv.locator('a', { hasText: 'ext' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual(['https://example.com/page']);
  expect(page.url()).toBe(url);
  await pv.locator('a', { hasText: 'rel' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('notes/kubernetes.md');
  expect(page.url()).toBe(url);
});

test('showcase: embeds, mermaid, diff, line numbers, footnotes, anchors, folding', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.write('Showcase.md', SHOWCASE);
  await start(page, ws, 'Showcase.md', 'preview');
  const pv = page.locator(P);
  await settle(page);

  // Embed of another note, transcluded and highlighted.
  const embed = pv.locator('.se-embed.is-loaded');
  await expect(embed.locator('.se-embed-body h1')).toHaveText('Kubernetes cheatsheet');
  await expect(embed.locator('.se-code[data-hl="1"]')).toHaveCount(1);
  // Mermaid → sanitized SVG.
  await expect(pv.locator('.se-mermaid > svg')).toBeVisible();
  await expect(pv.locator('.se-mermaid > svg')).toContainText('Looks good?');
  // Code: PHP highlighted, diff lines marked, line numbers.
  await expect(pv.locator('.se-code[data-lang="php"] .se-code-lang')).toHaveText('UserController.php · PHP');
  expect(await pv.locator('.se-code[data-lang="php"] code span[style*="--shiki"]').count()).toBeGreaterThan(10);
  await expect(pv.locator('.se-code[data-fence="diff"] .line.se-diff-add')).toHaveText('+added line');
  await expect(pv.locator('.se-code[data-fence="diff"] .line.se-diff-del')).toHaveText('-removed line');
  await expect(pv.locator('.se-code-numbers .line')).toHaveCount(2);
  // Math: inline + display, prices untouched.
  await expect(pv.locator('.se-math .katex')).toHaveCount(2);
  await expect(pv.locator('.se-math-display .katex-display')).toHaveCount(1);
  await expect(pv.getByText('prices like $5 and $10 stay text')).toBeVisible();
  // Callouts: nested + foldable.
  await expect(pv.locator('.se-callout .se-callout[data-callout="warning"]')).toContainText('Careful now.');
  const fold = pv.locator('details.se-callout');
  await expect(fold.locator('.se-callout-content')).toBeHidden();
  await fold.locator('summary').click();
  await expect(fold.locator('.se-callout-content')).toBeVisible();
  // Wikilinks resolved / unresolved, comment hidden, highlight, tags.
  await expect(pv.locator('a.se-wikilink.is-unresolved')).toHaveText('unresolved link');
  await expect(pv).not.toContainText('hidden comment');
  await expect(pv.locator('mark')).toHaveText('highlight');
  // Footnote link scrolls inside the preview (no navigation).
  await pv.locator('sup.footnote-ref a').click();
  await expect(pv.locator('.footnotes li')).toBeInViewport();
  // Heading anchor.
  const scroller = page.locator('.se-preview-scroller');
  await scroller.evaluate((el) => (el.scrollTop = 0));
  await pv.locator('h2', { hasText: 'Math' }).locator('a.se-anchor').evaluate((a: HTMLElement) => a.click());
  await expect(pv.locator('h2', { hasText: 'Math' })).toBeInViewport();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  expect(errors).toEqual([]);

  if (SHOTS) {
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await expect(pv.locator('.se-mermaid')).toHaveAttribute('data-done', theme);
      await page.waitForTimeout(400);
      const h = await scroller.evaluate((el) => el.scrollHeight);
      let i = 0;
      for (let y = 0; y < h - 300 && i < 5; y += 760, i++) {
        await scroller.evaluate((el, top) => (el.scrollTop = top), y);
        await page.waitForTimeout(250);
        await shot(page, `showcase-${theme}-${i}.png`);
      }
    }
  }
});

test('scroll sync works in both directions without feedback loops', async ({ page, ws }) => {
  const body = Array.from({ length: 80 }, (_, i) => `## Section ${i}\n\nParagraph ${i} with some text that is long enough to be a real paragraph in the preview pane.\n\n- item a\n- item b\n`).join('\n');
  await ws.write('long.md', `# Long\n\n${body}`);
  await start(page, ws, 'long.md');
  const pvScroll = page.locator('.se-preview-scroller');
  const edScroll = page.locator('.cm-scroller');
  const topHeading = () =>
    page.evaluate(() => {
      const host = document.querySelector('.se-preview-scroller')!;
      const top = host.getBoundingClientRect().top;
      const hs = [...host.querySelectorAll('h2')];
      const h = hs.find((x) => x.getBoundingClientRect().bottom > top + 1);
      return h ? Number(h.textContent!.replace(/\D/g, '')) : -1;
    });
  const editorTopSection = () =>
    page.evaluate(() => {
      const app = (window as any).__secEdit;
      const line = app.editor.getTopLine();
      const lines = app.editor.getContent().split('\n');
      for (let i = line; i < lines.length; i++) if (lines[i].startsWith('## Section')) return Number(lines[i].replace(/\D/g, ''));
      return -1;
    });

  // editor → preview
  await edScroll.hover();
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => pvScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await page.waitForTimeout(600);
  expect(Math.abs((await topHeading()) - (await editorTopSection()))).toBeLessThanOrEqual(1);
  // Stable: nothing keeps scrolling by itself.
  const a = [await edScroll.evaluate((el) => el.scrollTop), await pvScroll.evaluate((el) => el.scrollTop)];
  await page.waitForTimeout(500);
  expect([await edScroll.evaluate((el) => el.scrollTop), await pvScroll.evaluate((el) => el.scrollTop)]).toEqual(a);

  // preview → editor
  await pvScroll.hover();
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(700);
  expect(await edScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(a[0] + 1000);
  expect(Math.abs((await topHeading()) - (await editorTopSection()))).toBeLessThanOrEqual(1);
  const b = [await edScroll.evaluate((el) => el.scrollTop), await pvScroll.evaluate((el) => el.scrollTop)];
  await page.waitForTimeout(500);
  expect([await edScroll.evaluate((el) => el.scrollTop), await pvScroll.evaluate((el) => el.scrollTop)]).toEqual(b);

  // Ctrl/Cmd+click on a block jumps to its source line in the editor.
  const para = page.locator(`${P} p`, { hasText: 'Paragraph 77 ' });
  await para.scrollIntoViewIfNeeded();
  await para.click({ modifiers: ['ControlOrMeta'] });
  await expect
    .poll(() => page.evaluate(() => {
      const app = (window as any).__secEdit;
      return app.editor.getContent().split('\n')[app.editor.getCursor().line];
    }))
    .toContain('Paragraph 77 ');

  // Controller API used by other modules (outline etc.).
  await page.evaluate(() => (window as any).__secEdit.preview.scrollToLine(0));
  expect(await pvScroll.evaluate((el) => el.scrollTop)).toBe(0);
  const line = await page.evaluate(() => (window as any).__secEdit.editor.getContent().split('\n').indexOf('## Section 40'));
  await page.evaluate((l) => (window as any).__secEdit.preview.scrollToLine(l), line);
  expect(await topHeading()).toBe(40);
});

test('commands: export to HTML, copy as HTML, print', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.write('Showcase.md', SHOWCASE);
  await start(page, ws, 'Showcase.md');
  const run = async (title: string) => {
    await page.keyboard.press('Control+Shift+p');
    await expect(page.getByRole('dialog').locator('input')).toBeFocused();
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
  };

  const download = page.waitForEvent('download');
  await run('Export note to HTML');
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('Showcase.html');
  const html = fs.readFileSync(await dl.path(), 'utf8');
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('<title>Preview showcase</title>');
  expect(html).toContain('<style>');
  expect(html).not.toMatch(/<script|<link /i);
  expect(html).toContain('--shiki-light');
  expect(html).toContain('<math');
  expect(html).toContain('<svg');
  expect(html).toContain('Kubernetes cheatsheet');
  expect(html).not.toContain('se-code-copy"');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, 'Showcase.html'), html);
    const p2 = await context.newPage();
    await p2.emulateMedia({ colorScheme: 'light' });
    await p2.goto(`file://${path.join(SHOTS, 'Showcase.html')}`);
    await p2.screenshot({ path: path.join(SHOTS, 'export-light.png') });
    await p2.emulateMedia({ media: 'print' });
    await p2.pdf({ path: path.join(SHOTS, 'export.pdf') }).catch(() => {});
    await p2.close();
  }

  await run('Copy as HTML');
  await expect(page.locator('.se-toast', { hasText: 'Copied as HTML' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('<h1');
  expect(copied).toContain('style="color:');
  expect(copied).not.toContain('se-code-copy');

  await page.evaluate(() => {
    (window as any).__printed = 0;
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      (window as any).__printed = document.querySelectorAll('.se-print-path').length;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  // Browser mode has no PDF engine: "Export note to PDF…" falls back to the print dialog.
  await run('Export note to PDF');
  await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBeGreaterThan(2);
  await expect(page.locator('.se-print-path, .se-print-hide')).toHaveCount(0);
});

test('screenshots (dark + light) of Daily notes and README', async ({ page, ws }) => {
  test.skip(!SHOTS, 'set SEC_EDIT_SHOTS=/dir to capture');
  for (const [file, name] of [['notes/Daily notes.md', 'daily'], ['README.md', 'readme']] as const) {
    await start(page, ws, file);
    await settle(page);
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await shot(page, `${name}-${theme}-split.png`);
    }
    await setMode(page, 'preview');
    await page.waitForTimeout(250);
    await shot(page, `${name}-light-preview.png`);
    // What the print fallback produces (dark app theme must still print dark-on-white).
    await page.evaluate(() => ((document.documentElement.dataset.theme = 'dark'), window.dispatchEvent(new Event('beforeprint'))));
    await page.pdf({ path: path.join(SHOTS, `${name}-print.pdf`), printBackground: true }).catch((e) => console.log('pdf failed', e.message));
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await page.waitForTimeout(250);
    await shot(page, `${name}-dark-preview.png`);
  }
});
