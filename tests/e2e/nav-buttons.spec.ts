// Back / forward buttons at the start of the tab strip (nav/buttons.tsx, browser mode): where they sit in
// each layout, greyed out at the ends and live, clicks step (the editor keeps focus), right-click / long
// press / keyboard list the recent places, Esc closes the list, a row jumps there, Settings hides them.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';
import { appRegionReport, forceIntegratedFrame } from './frame-regions';

const A = 'navb/alpha.md';
const B = 'navb/beta.md';
const C = 'navb/gamma.ts';
/** Longer than the 350 ms window in which jumps coalesce into one entry. */
const SETTLE = 450;

const filler = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name} text ${i + 1}`);

test.beforeEach(async ({ page, ws }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  fs.mkdirSync(path.join(ws.root, 'navb'), { recursive: true });
  // alpha.md: "Setup" starts at line 41 (0-based 40), "Usage" at 82.
  fs.writeFileSync(path.join(ws.root, A), ['# Alpha', ...filler('alpha', 39), '## Setup', ...filler('setup', 41), '## Usage', ...filler('usage', 100)].join('\n') + '\n');
  fs.writeFileSync(path.join(ws.root, B), ['# Beta', ...filler('beta', 200)].join('\n') + '\n');
  fs.writeFileSync(path.join(ws.root, C), filler('// gamma', 120).join('\n') + '\n');
});

async function boot(page: Page, ws: WsFixture) {
  await ws.open(page);
  await page.waitForFunction(() => !!(window as any).__secEditNav); // the recorder chunk (idle after boot)
}

const where = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).__secEdit;
    return `${app.activePath.value}:${app.editor?.getCursor().line ?? -1}`;
  });

async function open(page: Page, file: string, line = 0) {
  await page.evaluate(([f, l]) => (window as any).__secEdit.openFile(f, { line: l, col: 0 }), [file, line] as const);
  await expect.poll(() => where(page)).toBe(`${file}:${line}`);
  await page.waitForTimeout(SETTLE);
}

const back = (page: Page) => page.locator('.se-topline .se-navbtns [aria-label="Go back"]');
const fwd = (page: Page) => page.locator('.se-topline .se-navbtns [aria-label="Go forward"]');
const off = async (page: Page) => [await back(page).getAttribute('aria-disabled'), await fwd(page).getAttribute('aria-disabled')].map((v) => v === 'true');
const menu = (page: Page) => page.locator('.se-menu[role="menu"]');
const rows = (page: Page) => menu(page).locator('.se-menu-item').evaluateAll((els) => els.map((e) => `${e.querySelector('.se-menu-label')?.textContent} | ${e.querySelector('.se-menu-keys')?.textContent ?? ''}`));
const editorFocused = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
/** Classes of .se-topline's children, left to right (skipping nothing: the strip's order is the point). */
const topline = (page: Page) => page.locator('.se-topline').evaluate((el) => [...el.children].map((c) => c.classList[0]));
const rect = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);

test('greyed out at the ends and live; clicks step back / forward and leave the focus in the editor', async ({ page, ws }) => {
  await boot(page, ws);
  await expect(page.locator('.se-navbtns')).toBeVisible();
  await open(page, A, 50);
  expect(await off(page)).toEqual([true, true]); // one place: nowhere to go yet
  await open(page, B, 3);
  expect(await off(page)).toEqual([false, true]);
  await open(page, C, 0);

  await expect(back(page)).toHaveAttribute('title', 'Go back (Alt+←) · mouse back button\nRight-click or hold: recent places');
  await expect(fwd(page)).toHaveAttribute('title', /^Go forward \(Alt\+→\) · mouse forward button/);

  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await back(page).click();
  await expect.poll(() => where(page)).toBe(`${B}:3`);
  expect(await off(page)).toEqual([false, false]);
  expect(await editorFocused(page)).toBe(true);
  await back(page).click();
  await expect.poll(() => where(page)).toBe(`${A}:50`);
  await expect.poll(() => off(page)).toEqual([true, false]);
  // A greyed-out arrow does nothing, but stays a focusable button (aria-disabled, not disabled;
  // Playwright counts aria-disabled as not clickable, hence force).
  await back(page).click({ force: true });
  await page.waitForTimeout(150);
  expect(await where(page)).toBe(`${A}:50`);
  expect(await back(page).evaluate((b: HTMLButtonElement) => b.disabled)).toBe(false);
  await fwd(page).click();
  await fwd(page).click();
  await expect.poll(() => where(page)).toBe(`${C}:0`);
  await expect.poll(() => off(page)).toEqual([false, true]);
  // The keys move the same history, and the buttons follow.
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${B}:3`);
  await expect.poll(() => off(page)).toEqual([false, false]);
  // A new navigation drops the forward places.
  await open(page, A, 120);
  await expect.poll(() => off(page)).toEqual([false, true]);
});

test('right-click lists the recent places (file + heading / line), Esc closes it; a row jumps straight there', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 45); // under "## Setup"
  await open(page, C, 7);
  await open(page, B, 2);
  await open(page, A, 90); // under "## Usage"

  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await back(page).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect.poll(() => rows(page)).toEqual(['beta.md | Beta', 'gamma.ts | line 8', 'alpha.md | Setup']);
  // The list hangs under the button, inside the window.
  const [btn, m] = [await rect(page, '.se-navbtns [aria-label="Go back"]'), await rect(page, '.se-menu')];
  expect(m.y).toBeGreaterThanOrEqual(btn.bottom);
  expect(Math.abs(m.x - btn.x)).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  expect(await where(page)).toBe(`${A}:90`); // nothing moved
  await expect.poll(() => editorFocused(page)).toBe(true); // focus back where it was

  // The forward list is empty here: right-click opens nothing.
  await fwd(page).click({ button: 'right', force: true });
  await page.waitForTimeout(200);
  await expect(menu(page)).toHaveCount(0);

  // Pick the third row: straight to alpha.md:45, the places in between are now forward of it.
  await back(page).click({ button: 'right' });
  await menu(page).locator('.se-menu-item').nth(2).click();
  await expect.poll(() => where(page)).toBe(`${A}:45`);
  await expect.poll(() => off(page)).toEqual([true, false]);
  await fwd(page).click({ button: 'right' });
  await expect.poll(() => rows(page)).toEqual(['gamma.ts | line 8', 'beta.md | Beta', 'alpha.md | Usage']);
  // A click outside closes it too (on the strip's empty end: a click in the text could be a jump of its own).
  await page.locator('.se-tabs-end').click();
  await expect(menu(page)).toHaveCount(0);
  await fwd(page).click();
  await expect.poll(() => where(page)).toBe(`${C}:7`);
});

test('long press opens the list without stepping; the keyboard reaches it (Shift+F10, ↑ ↓ Enter, Esc)', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 45);
  await open(page, B, 2);
  await open(page, C, 7);

  // Long press: the list opens while the button is held; letting go does not also step.
  const b = await rect(page, '.se-navbtns [aria-label="Go back"]');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(menu(page)).toBeVisible();
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await where(page)).toBe(`${C}:7`);
  await expect.poll(() => rows(page)).toEqual(['beta.md | Beta', 'alpha.md | Setup']);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);

  // Keyboard: the button is focusable; Shift+F10 opens the list with the focus in it, Esc gives it back.
  await back(page).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(back(page)).toBeFocused();
  // Again; ↓ ↓ Enter picks the second row.
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => where(page)).toBe(`${A}:45`);
  // Enter / Space on the focused button step like a click.
  await fwd(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => where(page)).toBe(`${B}:2`);
});

test('placement: start of the strip in shelf (sidebar shown / hidden), classic and zen; about 50 px; integrated frame regions', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 0);
  await open(page, B, 0);
  const checkCell = async () => {
    const nav = await rect(page, '.se-navbtns');
    const tab = await rect(page, '.se-tab');
    const bar = await rect(page, '.se-tabbar');
    expect(nav.width).toBeGreaterThanOrEqual(44);
    expect(nav.width).toBeLessThanOrEqual(60);
    expect(nav.height).toBe(bar.height); // a cell of the strip, ruled like a tab
    expect(nav.right).toBeLessThanOrEqual(tab.x + 0.5);
    return nav;
  };

  // Shelf, sidebar shown: the very first thing in the strip.
  expect(await topline(page)).toEqual(['se-navbtns', 'se-tabbar']);
  await checkCell();
  // Shelf, sidebar hidden: [show sidebar] ◀ ▶ │ tabs — one cell with the reveal button.
  await page.keyboard.press('Control+Shift+b');
  expect(await topline(page)).toEqual(['se-shelf-reveal', 'se-navbtns', 'se-tabbar']);
  const nav = await checkCell();
  const reveal = await rect(page, '.se-shelf-reveal');
  expect(Math.abs(reveal.right - nav.x)).toBeLessThan(0.5);
  expect(await page.locator('.se-shelf-reveal').evaluate((e) => getComputedStyle(e).borderRightWidth)).toBe('0px');
  await page.keyboard.press('Control+Shift+b');

  // Integrated frame (forced in the browser): the buttons are no-drag, their gaps drag like the strip, no mismatch.
  await forceIntegratedFrame(page);
  for (const sel of ['.se-navbtns [aria-label="Go back"]', '.se-navbtns [aria-label="Go forward"]']) {
    expect(await page.locator(sel).evaluate((e) => (getComputedStyle(e) as any).webkitAppRegion), sel).toBe('no-drag');
  }
  const r = await appRegionReport(page);
  expect(r.mismatches).toEqual([]);
  expect(r.leaks).toEqual([]);

  // Classic: the same spot (no reveal button in classic).
  await page.keyboard.press('Control+,');
  await page.locator('[data-setting="sidebarStyle"] [data-value="classic"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-root.ui-classic .se-activity')).toBeVisible();
  expect(await topline(page)).toEqual(['se-navbtns', 'se-tabbar']);
  await checkCell();
  await page.keyboard.press('Control+Shift+b');
  expect(await topline(page)).toEqual(['se-navbtns', 'se-tabbar']);
  await page.keyboard.press('Control+Shift+b');

  // Zen (windowed): tabs stay, so do the buttons, at the strip's start; the leave-zen button stays at its end.
  await page.evaluate(() => {
    const s = (window as any).__secEdit;
    s.settings.value = { ...s.settings.value, 'zen.fullScreen': false };
  });
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen')).toBeVisible();
  expect(await topline(page)).toEqual(['se-navbtns', 'se-tabbar']);
  await checkCell();
  await expect(page.locator('.se-tabbar-tools .se-zen-btn')).toBeVisible();
  await back(page).click();
  await expect.poll(() => where(page)).toBe(`${A}:0`);
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen')).toHaveCount(0);
});

test('Settings → Appearance → "Back and forward buttons" hides them; the keys keep working', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 0);
  await open(page, B, 0);
  await page.keyboard.press('Control+,');
  const sw = page.locator('[data-setting="nav.buttons"]');
  await expect(sw).toHaveAttribute('aria-checked', 'true'); // shown by default
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-navbtns')).toHaveCount(0);
  expect(await topline(page)).toEqual(['se-tabbar']);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${A}:0`);
  // Remembered across a reload (settings.json), then back on.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('.se-tabbar')).toBeVisible();
  await expect(page.locator('.se-navbtns')).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await page.locator('[data-setting="nav.buttons"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-navbtns')).toBeVisible();
});
