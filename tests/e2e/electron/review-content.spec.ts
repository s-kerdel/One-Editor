// Security review, content side, in the real Electron app: the page runs the build's scripts only — a
// workspace file (app://sec-edit/__ws/…) never executes, whatever a note or a sanitizer slip manages.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';

test("script-src: only the build's assets run, never a workspace file", async ({ el }) => {
  await fsp.writeFile(path.join(el.ws, 'evil.js'), 'window.__pwned = 1;');
  const { page } = await el.launch([el.ws]);
  await page.waitForSelector('html[data-ready="true"]');
  const r = await page.evaluate(async () => {
    const load = (src: string) =>
      new Promise<string>((resolve) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve('ran');
        s.onerror = () => resolve('blocked');
        document.head.append(s);
      });
    const asset = [...document.scripts].map((s) => s.src).find((u) => u.includes('/assets/'))!;
    return { workspace: await load('app://sec-edit/__ws/evil.js'), root: await load('app://sec-edit/evil.js'), asset: await load(`${asset}?again`), pwned: (window as any).__pwned };
  });
  expect(r).toEqual({ workspace: 'blocked', root: 'blocked', asset: 'ran', pwned: undefined });
});
