// Security review: a hostile note (as found in a cloned repo) must never run script, navigate the app,
// or escape the preview — in live, split and reading view, through embeds, and in exported HTML.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness';

const OUT = fileURLToPath(new URL('../../.tmp/review/e2e', import.meta.url));
const PWN = 'window.__pwned=(window.__pwned||0)+1';

const EVIL = `# Hostile note

<script>${PWN}</script>
<img src=x onerror="${PWN}">
<svg onload="${PWN}"><foreignObject><img src=x onerror="${PWN}"></foreignObject><a xlink:href="javascript:${PWN}"><text y="20">svg link</text></a></svg>
<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>
<meta http-equiv="refresh" content="0;url=https://example.com/">
<base href="https://example.com/">
<form action="https://example.com/"><button id="evil-submit">submit</button></form>
<object data="evil.svg"></object><embed src="evil.svg">
<style>body{display:none!important}</style>
<details open ontoggle="${PWN}"><summary>details</summary>x</details>
<div style="p\\osition:fixed;inset:0;z-ind\\ex:2147483647;background:red" id="overlay-escape">escaped overlay</div>

<a id="l-js" href="javascript:${PWN}">js link</a>
<a id="l-data" href="data:text/html,<script>${PWN}</script>">data link</a>
<a id="l-ext" href="https://example.com/" target="_blank">external</a>
<a id="l-ws" href="evil.svg">workspace svg</a>

[md js](javascript:${PWN}) ![img](evil.svg) $\\href{javascript:${PWN}}{katex}$

![[evil-embed]]

\`\`\`mermaid
%%{init: {"themeCSS": "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;"}}%%
graph TD
  A["<img src=x onerror='${PWN}'>"] --> B
  click A "javascript:${PWN}"
\`\`\`

<!-- mXSS last: an unclosed <style> inside MathML swallows everything after it -->
<math><mtext><table><mglyph><style><img src=x onerror="${PWN}">
`;

const EMBED = `## Embedded\n\n<img src=x onerror="${PWN}"><script>${PWN}</script>\n`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" onload="${PWN}"><script>${PWN}</script><rect width="10" height="10"/></svg>`;

async function setMode(page: Page, mode: 'live' | 'source' | 'split' | 'preview') {
  await page.evaluate(async (m) => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings({ viewMode: m });
    app.editor?.setViewMode(m);
    app.events.emit('settings:changed', app.settings.value);
  }, mode);
}

function watch(page: Page) {
  const dialogs: string[] = [];
  const popups: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.context().on('page', (p) => popups.push(p.url()));
  return { dialogs, popups };
}

const pwned = (page: Page) => page.evaluate(() => (window as any).__pwned ?? 0);

test.describe('hostile markdown', () => {
  test.beforeEach(async ({ ws }) => {
    await ws.write('evil.md', EVIL);
    await ws.write('evil-embed.md', EMBED);
    await ws.write('evil.svg', SVG);
    // Draw the hostile diagram (an <img> label + themeCSS): with the default policy it is not drawn at all.
    await ws.server.service.saveSettings({ 'preview.remoteImages': 'always' });
  });

  for (const mode of ['live', 'split', 'preview'] as const) {
    test(`nothing executes in ${mode} view`, async ({ page, ws }) => {
      const seen = watch(page);
      await ws.open(page);
      const url = page.url();
      await setMode(page, mode);
      await page.evaluate(() => (window as any).__secEdit.openFile('evil.md'));
      await expect(page.locator('.cm-content')).toContainText('Hostile note', { timeout: 10000 }).catch(() => {});
      if (mode !== 'live') {
        await page.evaluate(() => (window as any).__secEdit.preview?.settle?.());
        await expect(page.locator('.se-preview .se-embed.is-loaded')).toHaveCount(1);
        await expect(page.locator('.se-preview .se-mermaid svg')).toHaveCount(1, { timeout: 15000 });
      }
      // Hover / click everything a reader might touch.
      for (const sel of ['#l-js', '#l-data', '#l-ext', '#l-ws', '#evil-submit', 'summary', '.se-mermaid svg']) {
        const el = page.locator(`.se-preview ${sel}`).first();
        if (await el.count()) await el.click({ force: true, timeout: 2000 }).catch(() => {});
      }
      await page.mouse.move(400, 300);
      await page.waitForTimeout(400);
      expect(await pwned(page)).toBe(0);
      expect(seen.dialogs).toEqual([]);
      // Only the deliberate click on the plain https link may open a browser tab.
      expect(seen.popups.filter((u) => !u.startsWith('about:blank') && u !== 'https://example.com/')).toEqual([]);
      expect(page.url()).toBe(url); // never navigated away (unsaved edits would be lost)
      // The app chrome is still visible and on top: no overlay, no injected <style> hid it.
      await expect(page.locator('body')).toBeVisible();
      const top = await page.evaluate(() => document.elementFromPoint(5, 5)?.closest('.se-preview, .se-mermaid, [id="overlay-escape"]') ? 'content' : 'app');
      expect(top).toBe('app');
      expect(await page.locator('#overlay-escape[style]').count()).toBe(0);
    });
  }

  test('CSP is a second layer: an injected inline handler does not run', async ({ page, ws }) => {
    await ws.open(page);
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<img src="data:," onerror="window.__pwned=1"><a href="javascript:window.__pwned=1" id="csp-a">x</a>';
      document.body.append(d);
      (document.getElementById('csp-a') as HTMLAnchorElement).click();
      const s = document.createElement('script');
      s.textContent = 'window.__pwned=1';
      document.body.append(s);
    });
    await page.waitForTimeout(300);
    expect(await pwned(page)).toBe(0);
  });

  test('exported HTML is inert when opened in a browser', async ({ page, ws, context }) => {
    await ws.open(page);
    await setMode(page, 'split');
    await page.evaluate(() => (window as any).__secEdit.openFile('evil.md'));
    await expect(page.locator('.se-preview .se-embed.is-loaded')).toHaveCount(1);
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Export note to HTML');
    await page.keyboard.press('Enter');
    const dl = await download;
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `evil-${test.info().workerIndex}.html`);
    await dl.saveAs(file);
    const p2 = await context.newPage();
    const seen = watch(p2);
    await p2.goto(`file://${file}`);
    // Inspect the parsed DOM (TeX source like "\href{javascript:…}" legitimately survives as text).
    const bad = await p2.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll('*')) {
        // The exporter's own CSP <meta> in <head> is expected; any other http-equiv meta is hostile.
        const ownCsp = el.localName === 'meta' && el.parentElement === document.head && /^content-security-policy$/i.test(el.getAttribute('http-equiv') ?? '');
        if (/^(script|iframe|object|embed|meta|base|form|link)$/i.test(el.localName) && !(el.localName === 'meta' && !el.getAttribute('http-equiv')) && !ownCsp) out.push(el.localName);
        for (const a of el.attributes) {
          if (/^on/i.test(a.name)) out.push(`${el.localName}[${a.name}]`);
          if (/href|src|action/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) out.push(`${el.localName}[${a.name}]`);
        }
      }
      return out;
    });
    expect(bad).toEqual([]);
    await p2.waitForTimeout(500);
    for (const a of await p2.locator('a').all()) await a.click({ force: true, timeout: 1000, modifiers: [] }).catch(() => {});
    expect(await p2.evaluate(() => (window as any).__pwned ?? 0)).toBe(0);
    expect(seen.dialogs).toEqual([]);
    await p2.close();
  });
});
