// Go back / Go forward in the real app: mouse side buttons (CDP), the Windows `app-command` route
// (main → renderer) and "one press = one step" when both arrive.
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixture';

const FILES = ['README.md', 'notes/kubernetes.md', 'code/app.ts'];

async function prepare(page: Page) {
  await page.waitForFunction(() => !!(window as any).__secEditNav);
  for (const f of FILES) {
    await page.evaluate((p) => (window as any).__secEdit.openFile(p), f);
    await expect.poll(() => active(page)).toBe(f);
  }
  expect(await paths(page)).toEqual(FILES);
}
const active = (page: Page) => page.evaluate(() => (window as any).__secEdit.activePath.value as string | null);
const paths = (page: Page) => page.evaluate(() => (window as any).__secEditNav.history.entries.map((e: { path: string }) => e.path) as string[]);
const index = (page: Page) => page.evaluate(() => (window as any).__secEditNav.history.index as number);

async function sideButton(page: Page, button: 'back' | 'forward', x = 600, y = 300) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'back' ? 8 : 16, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  await cdp.detach();
}

/** What Windows sends for a side button: BrowserWindow 'app-command'. Returns whether main cancelled it. */
const appCommand = (app: ElectronApplication, cmd: string) =>
  app.evaluate(({ BrowserWindow }, c) => {
    let prevented = false;
    BrowserWindow.getAllWindows()[0].emit('app-command', { preventDefault: () => void (prevented = true) }, c);
    return prevented;
  }, cmd);

test('mouse side buttons step back and forward, one step per press, without leaving the app', async ({ el }) => {
  const { page } = await el.launch();
  await prepare(page);
  const url = page.url();

  await sideButton(page, 'back');
  await expect.poll(() => active(page)).toBe(FILES[1]);
  await page.waitForTimeout(300);
  expect(await index(page)).toBe(1);
  await sideButton(page, 'back', 60, 400); // over the sidebar
  await expect.poll(() => active(page)).toBe(FILES[0]);
  await sideButton(page, 'back'); // nothing further back
  await page.waitForTimeout(300);
  expect(await active(page)).toBe(FILES[0]);
  await sideButton(page, 'forward');
  await expect.poll(() => active(page)).toBe(FILES[1]);
  await sideButton(page, 'forward');
  await expect.poll(() => active(page)).toBe(FILES[2]);
  expect(page.url()).toBe(url);
  expect(await paths(page)).toEqual(FILES);
  // Alt+Left is the keyboard route.
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => active(page)).toBe(FILES[1]);
});

test('app-command (Windows side buttons) reaches the renderer; with the mouse event it is still one step', async ({ el }) => {
  const { app, page } = await el.launch();
  await prepare(page);

  expect(await appCommand(app, 'browser-backward')).toBe(true);
  await expect.poll(() => active(page)).toBe(FILES[1]);
  expect(await appCommand(app, 'volume-up')).toBe(false); // not ours
  expect(await appCommand(app, 'browser-forward')).toBe(true);
  await expect.poll(() => active(page)).toBe(FILES[2]);
  await page.waitForTimeout(350); // past the echo window

  // One physical press on Windows = DOM mouse event + app-command.
  await Promise.all([sideButton(page, 'back'), appCommand(app, 'browser-backward')]);
  await expect.poll(() => active(page)).toBe(FILES[1]);
  await page.waitForTimeout(400);
  expect(await index(page)).toBe(1);
  expect(await active(page)).toBe(FILES[1]);
  // …and the next press is a step of its own.
  await Promise.all([appCommand(app, 'browser-backward'), sideButton(page, 'back')]);
  await expect.poll(() => active(page)).toBe(FILES[0]);
  await page.waitForTimeout(400);
  expect(await index(page)).toBe(0);
});
