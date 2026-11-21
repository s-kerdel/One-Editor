// Sidebar shown/hidden survives a refresh (every way of toggling it, both sidebar styles), the
// "show sidebar" cell of the tab strip, and double-click-to-close on tabs.
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const visible = (page: Page) => page.evaluate(() => (window as any).__secEdit.sidebarVisible.value as boolean);
const sessionVisible = async (ws: WsFixture) => ((await ws.server.service.getSession()) as any)?.sidebarVisible;
const rect = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  }, sel);

async function boot(page: Page, ws: WsFixture, style: 'shelf' | 'classic') {
  await ws.server.service.saveSettings({ sidebarStyle: style });
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
  await expect(page.locator('.cm-content')).toContainText('Daily notes');
}

/** Reload with the app bundle held back: returns the skeleton's card rect + whether its sidebar shows. */
async function reloadWithSkeleton(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  const nav = page.reload();
  await page.waitForSelector('.sk-main', { state: 'attached' });
  const skel = await page.evaluate(() => {
    const r = document.querySelector('.sk-main')!.getBoundingClientRect();
    const side = document.querySelector('.sk-side')!;
    // Nothing of the sidebar skeleton may paint over the card while hidden.
    const leaked = [...side.querySelectorAll('*')].some((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none');
    return { card: [r.x, r.y, r.width, r.height], side: getComputedStyle(side).display !== 'none', leaked, bg: getComputedStyle(document.body).backgroundColor };
  });
  release();
  await nav;
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await page.unroute(/\/assets\/index-[^/]+\.js$/);
  return skel;
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: a hidden sidebar stays hidden after a refresh, and the skeleton matches`, async ({ page, ws }) => {
    await boot(page, ws, style);
    await page.keyboard.press('Control+Shift+B');
    await expect(page.locator('.se-sidebar')).toHaveCount(0);
    await expect.poll(() => sessionVisible(ws)).toBe(false);

    const skel = await reloadWithSkeleton(page);
    expect(await visible(page)).toBe(false);
    await expect(page.locator('.se-sidebar')).toHaveCount(0);
    expect(skel.side).toBe(false);
    expect(skel.leaked).toBe(false);
    const card = await rect(page, '.se-content');
    // Same card position → nothing jumps when the UI replaces the skeleton (shelf: 8px margins all round).
    expect(card.slice(0, 3)).toEqual(skel.card.slice(0, 3));
    expect(Math.abs(card[3] - skel.card[3]) <= (style === 'classic' ? 24 : 0)).toBe(true);
    expect(card.slice(0, 2)).toEqual(style === 'classic' ? [48, 0] : [8, 8]);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.se-root')!).backgroundColor)).toBe(skel.bg);

    // Shown again → also remembered.
    await page.keyboard.press('Control+Shift+B');
    await expect(page.locator('.se-sidebar')).toBeVisible();
    await expect.poll(() => sessionVisible(ws)).toBe(true);
    const skel2 = await reloadWithSkeleton(page);
    expect(skel2.side).toBe(true);
    await expect(page.locator('.se-sidebar')).toBeVisible();
    expect((await rect(page, '.se-content')).slice(0, 3)).toEqual(skel2.card.slice(0, 3));
  });

  test(`${style}: every way of toggling the sidebar is remembered`, async ({ page, ws }) => {
    await boot(page, ws, style);
    const reloadExpect = async (want: boolean) => {
      await expect.poll(() => sessionVisible(ws)).toBe(want);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sec-edit-layout')!).sb)).toBe(want);
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
      expect(await visible(page)).toBe(want);
      await expect(page.locator('.se-sidebar')).toHaveCount(want ? 1 : 0);
    };

    // 1. the buttons of the style
    if (style === 'shelf') {
      await page.getByRole('button', { name: 'Hide sidebar' }).click();
      await reloadExpect(false);
      await page.getByRole('button', { name: 'Show sidebar' }).click();
      await reloadExpect(true);
    } else {
      await page.locator('.se-activity-btn[data-panel="files"]').click(); // re-click the open panel
      await reloadExpect(false);
      await page.locator('.se-activity-btn[data-panel="files"]').click();
      await reloadExpect(true);
    }
    // 2. the palette command (same as Ctrl+Shift+B)
    await page.evaluate(() => (window as any).__secEdit.sidebarVisible.value);
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('toggle sidebar');
    await page.keyboard.press('Enter');
    await reloadExpect(false);
    // 3. Ctrl+Shift+B (the status bar has no sidebar button any more)
    await page.keyboard.press('Control+Shift+B');
    await reloadExpect(true);
    // 4. dragging the sash shut
    const sb = (await page.locator('.se-sidebar').boundingBox())!;
    await page.mouse.move(sb.x + sb.width, sb.y + 300);
    await page.mouse.down();
    await page.mouse.move(sb.x + 60, sb.y + 300, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.se-sidebar')).toHaveCount(0);
    await reloadExpect(false);
  });
}

test('shelf, sidebar hidden: the "show sidebar" button is a native cell of the tab strip', async ({ page, ws }) => {
  await boot(page, ws, 'shelf');
  await page.locator('.se-tab', { hasText: 'app.ts' }).click(); // first tab active: it sits right next to the button
  await page.keyboard.press('Control+Shift+B');
  const btn = page.getByRole('button', { name: 'Show sidebar' });
  await expect(btn).toBeVisible();
  const g = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s)!;
    const b = q('.se-shelf-reveal').getBoundingClientRect();
    const bar = q('.se-tabbar').getBoundingClientRect();
    const tab = q('.se-tab').getBoundingClientRect();
    const icon = q('.se-shelf-reveal svg').getBoundingClientRect();
    const cs = getComputedStyle(q('.se-shelf-reveal'));
    const barCs = getComputedStyle(q('.se-tabbar'));
    // Back / forward (nav/buttons.tsx, on by default) join the cell: [show sidebar] ◀ ▶ │ tabs.
    const nav = document.querySelector('.se-navbtns');
    const sepCs = getComputedStyle(nav ?? q('.se-shelf-reveal'));
    return {
      b: [b.left, b.top, b.bottom, b.right],
      bar: [bar.left, bar.top, bar.bottom],
      next: (nav ?? q('.se-tabbar')).getBoundingClientRect().left,
      cellRight: (nav ?? q('.se-shelf-reveal')).getBoundingClientRect().right,
      sep: [sepCs.borderRightWidth, sepCs.borderRightColor, sepCs.borderBottomWidth],
      tabLeft: tab.left,
      iconDx: icon.left + icon.width / 2 - (b.left + (b.width - parseFloat(cs.borderRightWidth)) / 2),
      iconDy: icon.top + icon.height / 2 - (b.top + (b.height - 1) / 2),
      border: [cs.borderBottomWidth, cs.borderBottomColor, cs.borderRightWidth, cs.borderRightColor],
      barBorder: [barCs.borderBottomWidth, barCs.borderBottomColor],
      bg: cs.backgroundColor,
      card: q('.se-content').getBoundingClientRect().left,
    };
  });
  // Same height as the strip, flush with the card's left edge, the first tab starts right after it.
  expect(g.b[1]).toBe(g.bar[1]);
  expect(g.b[2]).toBe(g.bar[2]);
  expect(g.b[0]).toBe(g.card + 1); // card border
  expect(g.b[3]).toBe(g.next);
  expect(g.cellRight).toBe(g.bar[0]);
  expect(g.tabLeft).toBe(g.bar[0]);
  // The strip's bottom rule continues under it, and a separator sets the cell apart from the tabs.
  expect(g.border.slice(0, 2)).toEqual(g.barBorder);
  expect(g.sep).toEqual(['1px', g.barBorder[1], g.barBorder[0]]);
  // Icon centred in the cell.
  expect(Math.abs(g.iconDx)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(g.iconDy)).toBeLessThanOrEqual(0.5);
  // Hover + keyboard focus states.
  await btn.hover();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.se-shelf-reveal')!).backgroundColor)).not.toBe(g.bg);
  await page.mouse.move(700, 400);
  await btn.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(btn).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.se-shelf-reveal')!).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-sidebar')).toBeVisible();
  await expect(btn).toHaveCount(0);
});

test('double-clicking a tab name closes the file; a single click only activates', async ({ page, ws }) => {
  await boot(page, ws, 'shelf');
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  const tab = (name: string) => page.locator('.se-tab', { hasText: name });
  const active = () => page.evaluate(() => (window as any).__secEdit.activePath.value);
  await expect(page.locator('.se-tab')).toHaveCount(3);

  // Single click: activates, never closes.
  await tab('app.ts').locator('.se-tab-title').click();
  expect(await active()).toBe('code/app.ts');
  await page.waitForTimeout(600); // well past any double-click window
  await tab('app.ts').locator('.se-tab-title').click();
  await expect(page.locator('.se-tab')).toHaveCount(3);

  // Double click on an inactive tab's name: closes it.
  await tab('README.md').locator('.se-tab-title').dblclick();
  await expect(tab('README.md')).toHaveCount(0);
  await expect(page.locator('.se-tab')).toHaveCount(2);

  // Dirty doc with autosave: saved on the way out (same rules as the × button).
  await tab('Daily notes.md').locator('.se-tab-title').click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\ndblclick-close-marker');
  await tab('Daily notes.md').locator('.se-tab-title').dblclick();
  await expect(tab('Daily notes.md')).toHaveCount(0);
  await expect.poll(() => ws.read('notes/Daily notes.md')).toContain('dblclick-close-marker');

  // Autosave off: the usual "Save changes?" dialog; Cancel keeps the tab.
  await page.evaluate(() => (window as any).__secEdit.backend.saveSettings({ autosave: false }));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await expect(tab('app.ts')).toHaveClass(/active/);
  await page.locator('.cm-content').click();
  await page.keyboard.type('// edit\n');
  await expect(tab('app.ts')).toHaveClass(/dirty/);
  await tab('app.ts').locator('.se-tab-title').dblclick();
  await expect(page.locator('.se-dialog')).toContainText('Save changes to app.ts?');
  await page.locator('.se-dialog .se-btn', { hasText: 'Cancel' }).click();
  await expect(tab('app.ts')).toHaveCount(1);
  await tab('app.ts').locator('.se-tab-title').dblclick();
  await page.locator('.se-dialog .se-btn', { hasText: 'Don’t save' }).click();
  await expect(tab('app.ts')).toHaveCount(0);
  expect(await ws.read('code/app.ts')).not.toContain('// edit');
});

test('double-clicking a close button does not take the neighbouring tab with it', async ({ page, ws }) => {
  await boot(page, ws, 'shelf');
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.evaluate(() => (window as any).__secEdit.openFile('code/query.sql'));
  await expect(page.locator('.se-tab')).toHaveCount(4);
  // Close the first tab with a double click on its ×: the next tab slides under the pointer.
  const x = page.locator('.se-tab').first().locator('.se-tab-close');
  const box = (await x.boundingBox())!;
  await page.locator('.se-tab').first().hover();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2, delay: 40 });
  await page.waitForTimeout(200);
  // Whatever lands under the pointer second, at most the × itself was hit again — a tab *name* never closes this way.
  expect(await page.locator('.se-tab').count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.se-tab', { hasText: 'app.ts' })).toHaveCount(0);
});
