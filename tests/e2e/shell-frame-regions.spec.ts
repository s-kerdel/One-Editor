// Integrated window frame, many tabs: the strip scrolls, and tabs scrolled out of view must not cut
// no-drag holes into the title-bar areas next to it (Chromium sends every box's full border box, unclipped;
// user report: "can't drag the window from above the project folder selector with a lot of files open").
// Browser mode renders the integrated frame's CSS when forced; tests/e2e/electron/window-frame.spec.ts
// runs the same guard (and real pointer input) in the desktop app.
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';
import { appRegionReport, forceIntegratedFrame, manyNotes, openTabs, scrollTabs } from './frame-regions';

const NOTES = manyNotes(60);

async function setup(page: Page, ws: WsFixture) {
  await fsp.mkdir(`${ws.root}/many`, { recursive: true });
  for (const n of NOTES) await ws.write(n, `# ${n}\n`);
  await ws.open(page);
  await forceIntegratedFrame(page);
}

/** Region report at the strip's start, middle and end (each must be clean). */
async function everyScroll(page: Page) {
  const out: Record<string, Awaited<ReturnType<typeof appRegionReport>>> = {};
  for (const at of [1, 0.5, 0]) {
    const s = await scrollTabs(page, at);
    expect(s.overflow, 'the strip overflows').toBeGreaterThan(2000);
    out[`scrolled to ${at}`] = await appRegionReport(page);
  }
  return out;
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: 60 tabs — hidden tabs leave the title bar's drag areas alone, at every scroll position`, async ({ page, ws }) => {
    await setup(page, ws);
    if (style === 'classic') {
      await page.keyboard.press('Control+,');
      await page.locator('[data-setting="sidebarStyle"] [data-value="classic"]').click();
      await page.keyboard.press('Escape');
      await expect(page.locator('.se-root.ui-classic.frame-integrated .se-activity')).toBeVisible();
    }
    await openTabs(page, NOTES);
    await expect(page.locator('.se-tab')).toHaveCount(60);
    const reports = await everyScroll(page);
    for (const [where, r] of Object.entries(reports)) {
      expect(r.regions.drag, where).toBeGreaterThan(2);
      expect(r.mismatches, where).toEqual([]);
      expect(r.leaks, where).toEqual([]);
    }
    // File overview open: it takes the window's top-right corner (a drag band) next to the strip's end.
    await page.keyboard.press('Control+Alt+b');
    await expect(page.locator('.se-overview .se-ov-head')).toBeVisible();
    for (const [where, r] of Object.entries(await everyScroll(page))) {
      expect(r.mismatches, `overview open, ${where}`).toEqual([]);
      expect(r.leaks, `overview open, ${where}`).toEqual([]);
    }
  });
}

test('few tabs: the strip’s empty end still drags, tabs and their buttons do not', async ({ page, ws }) => {
  await setup(page, ws);
  await openTabs(page, NOTES.slice(0, 3));
  await expect(page.locator('.se-tab')).toHaveCount(3);
  const at = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  const strip = await page.locator('.se-tabs').boundingBox();
  const last = await page.locator('.se-tab').last().boundingBox();
  expect(strip!.x + strip!.width - (last!.x + last!.width)).toBeGreaterThan(40);
  const emptyEnd = { x: (last!.x + last!.width + strip!.x + strip!.width) / 2, y: strip!.y + strip!.height / 2 };
  const probes = [await at('.se-tab'), await at('.se-tab-close'), emptyEnd, await at('.se-ov-toggle'), { x: 60, y: 3 }];
  const r = await appRegionReport(page, { probes });
  expect(r.mismatches).toEqual([]);
  expect(r.leaks).toEqual([]);
  // A press: on a tab / its × / a strip button reaches the page; on the strip's empty end and the band above the switcher it drags.
  expect(r.probes).toEqual([false, false, true, false, true]);
});
