// Integrated terminal in the real Electron app (real node-pty + bash under Xvfb): panel, I/O, keys that
// must reach the shell, resize, tabs, run-in-terminal from a note, file links, Claude glue (stub CLI),
// live theming, no orphan processes after quit. SEC_EDIT_SHOTS=<dir> also writes screenshots.
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';

/** Visible terminal text (xterm's DOM renderer), nbsp → space. */
const termText = (page: Page) => page.evaluate(() => (document.querySelector('.se-term-view .xterm-rows')?.textContent ?? '').replace(/ /g, ' '));
const rows = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.se-term-view .xterm-rows > div')].map((d) => (d.textContent ?? '').replace(/ /g, ' ').trimEnd()));
const count = (s: string, needle: string) => s.split(needle).length - 1;
const active = (page: Page) => page.evaluate(() => {
  const m = (window as any).__secEditTerminal?.manager;
  const s = m?.active;
  return s ? { id: s.id, pid: s.pid, cols: s.view.cols, rows: s.view.rows, kind: s.shell.kind, title: s.title.value, n: m.sessions.value.length } : null;
});

/** Plain bash, no rc files (a developer's ~/.bashrc may `cd ~`), private HOME; `extra` env on top. */
async function launch(el: Parameters<Parameters<typeof test>[2]>[0]['el'], extra: Record<string, string> = {}) {
  const home = path.join(el.tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.bashrc'), 'PS1="term$ "\n');
  return el.launch([el.ws], { env: { SHELL: '/bin/bash', HOME: home, ...extra } });
}

async function openTerminal(page: Page) {
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect.poll(() => termText(page), { timeout: 15000 }).toContain('term$');
}

test('Ctrl+` opens bash in the workspace: I/O, readline keys, resize, hide/show, tabs, kill', async ({ el }) => {
  const { page } = await launch(el);
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await expect(page.locator('.se-tab.active')).toContainText('README.md');
  await openTerminal(page);
  await page.keyboard.type('echo SUM=$((6*7)); pwd\n');
  await expect.poll(() => termText(page)).toContain('SUM=42');
  expect(await termText(page)).toContain(el.ws);

  // Ctrl+W is readline's "delete word" here — not "close tab"; Ctrl+P (quick open) still reaches the app.
  await page.keyboard.type('echo abc def');
  await page.keyboard.press('Control+w');
  await page.keyboard.type('X\n');
  await expect.poll(() => termText(page)).toContain('abc X');
  await expect(page.locator('.se-tab.active')).toContainText('README.md');

  // The PTY has the panel's size.
  const a = (await active(page))!;
  await page.keyboard.type('stty size\n');
  await expect.poll(() => termText(page)).toContain(`${a.rows} ${a.cols}`);

  // Ctrl+` while focused hides the panel (the shell keeps running); again → same terminal back.
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  expect((await active(page))!.id).toBe(a.id);
  await expect.poll(() => termText(page)).toContain('SUM=42');

  // Second tab, rename, close (kills the shell).
  await page.getByTestId('terminal-new').click();
  await expect(page.locator('.se-term-tab')).toHaveCount(2);
  const b = (await active(page))!;
  await page.locator('.se-term-tab').nth(1).dblclick();
  await page.locator('.se-term-rename').fill('server');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-term-tab').nth(1)).toHaveText('server');
  await page.locator('.se-term-tab-close').nth(1).click();
  await expect(page.locator('.se-term-tab')).toHaveCount(1);
  await expect.poll(() => { try { process.kill(b.pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
});

test('no orphans: quitting the app kills shells and their background jobs', async ({ el }) => {
  const { app, page } = await launch(el);
  await openTerminal(page);
  await page.keyboard.type('sleep 300 & echo JOB=$!\n');
  await expect.poll(() => termText(page)).toMatch(/JOB=\d+/);
  const job = Number(/JOB=(\d+)/.exec(await termText(page))![1]);
  const shell = (await active(page))!.pid;
  await app.close();
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  await expect.poll(() => gone(shell) && gone(job), { timeout: 8000 }).toBe(true);
});

test('Run in terminal from a note pastes without pressing Enter (editor + preview)', async ({ el }) => {
  await fsp.writeFile(path.join(el.ws, 'notes', 'run.md'), '# Run\n\n```console\n$ echo RUN-OK\nRUN-OK\n```\n');
  const { page } = await launch(el);
  await page.locator('.se-tree-row', { hasText: 'notes' }).click();
  await page.locator('.se-tree-row', { hasText: 'run.md' }).click();
  const header = page.locator('.se-cb-header').first();
  await header.hover();
  await header.locator('.se-cb-run').click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect.poll(() => termText(page), { timeout: 15000 }).toContain('term$ echo RUN-OK');
  await page.waitForTimeout(400);
  expect(count(await termText(page), 'RUN-OK')).toBe(1); // typed at the prompt, not run (prompt + output stripped)
  await page.keyboard.press('Enter'); // the terminal has focus: the user runs it
  await expect.poll(async () => count(await termText(page), 'RUN-OK')).toBe(2);

  // Preview mode has the button too.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+e');
  const code = page.locator('.se-preview .se-code').first();
  await code.hover();
  await code.locator('.se-code-run').click();
  await expect.poll(async () => count(await termText(page), 'echo RUN-OK')).toBe(2);
});

test('file paths in the output open the file at that line (Ctrl+click)', async ({ el }) => {
  const { page } = await launch(el);
  await openTerminal(page);
  await page.keyboard.type('clear; echo "error at code/app.ts:2:7 here"\n');
  await expect.poll(() => termText(page)).toContain('error at code/app.ts:2:7 here');
  const i = (await rows(page)).findIndex((r) => r.startsWith('error at'));
  const row = page.locator('.se-term-view .xterm-rows > div').nth(i);
  const box = (await row.boundingBox())!;
  const a = (await active(page))!;
  const cell = (await page.locator('.se-term-view .xterm-screen').boundingBox())!.width / a.cols;
  const x = box.x + cell * ('error at '.length + 3.5);
  // Hovering a detected link shows the "Ctrl+click to open" hint: wait for it (link detection is async).
  await expect(async () => {
    await page.mouse.move(x - 4, box.y + box.height / 2);
    await page.mouse.move(x, box.y + box.height / 2);
    await expect(page.locator('.se-term-view[title="Ctrl+click to open"]')).toHaveCount(1, { timeout: 500 });
  }).toPass({ timeout: 10000 });
  await page.keyboard.down('Control');
  await page.mouse.click(x, box.y + box.height / 2);
  await page.keyboard.up('Control');
  await expect(page.locator('.se-tab.active')).toContainText('app.ts');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor())).toMatchObject({ line: 1, col: 6 }); // 0-based
});

test('Claude: preset in the shell picker + "Ask about selection" pre-fills a prompt, never submits', async ({ el }) => {
  const bin = path.join(el.tmp, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  // Stand-in for the Claude Code CLI: shows where it runs, then echoes lines (cat prints only after Enter).
  await fsp.writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "CLAUDE-STUB in $(pwd)"\nexec cat\n', { mode: 0o755 });
  const { page } = await launch(el, { PATH: `${bin}:${process.env.PATH}` });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.locator('.se-tree-row', { hasText: 'notes' }).click();
  await page.locator('.se-tree-row', { hasText: 'kubernetes.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Kubernetes cheatsheet');
  await page.evaluate(() => {
    const v = (window as any).__secEdit.editor.getView();
    v.focus(); // like a user selecting with the mouse
    v.dispatch({ selection: { anchor: v.state.doc.line(1).from, head: v.state.doc.line(1).to } });
  });
  // Right-click ON the selected text → "Ask Claude about selection".
  const at = await page.evaluate(() => {
    const c = (window as any).__secEdit.editor.getView().coordsAtPos(8);
    return { x: c.left + 2, y: (c.top + c.bottom) / 2 };
  });
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Ask Claude about selection' }).click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect.poll(() => termText(page), { timeout: 20000 }).toContain(`CLAUDE-STUB in ${el.ws}`);
  await expect.poll(() => termText(page), { timeout: 20000 }).toContain('@notes/kubernetes.md line 1: "# Kubernetes cheatsheet"');
  await page.waitForTimeout(500);
  expect(count(await termText(page), '@notes/kubernetes.md')).toBe(1); // only the echo: nothing was submitted
  expect((await active(page))!).toMatchObject({ kind: 'claude', title: 'Claude Code' });

  // From the focused terminal, Ctrl+Shift+P + typing goes to the palette (not into the shell);
  // "Ask about this file" reuses the same Claude terminal and appends to the unsent prompt.
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('ask about this file');
  await expect(page.getByRole('option', { name: 'Claude: Ask about this file' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => count(await termText(page), '@notes/kubernetes.md')).toBe(2);
  await page.waitForTimeout(500);
  expect(count(await termText(page), '@notes/kubernetes.md')).toBe(2); // still unsent (cat would repeat it)
  expect(await termText(page)).not.toContain('ask about this file');
  expect((await active(page))!.n).toBe(1);

  // The ▾ launcher card lists Claude Code with its own badge.
  await page.getByTestId('terminal-shells').click();
  const row = page.getByTestId('terminal-launcher').locator('.se-term-lrow', { hasText: 'Claude Code' });
  await expect(row).toBeVisible();
  await expect(row.locator('.se-term-badge')).toHaveAttribute('data-kind', 'claude');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('terminal-launcher')).toHaveCount(0);
});

test('maximize fills the editor area, restore brings the height back; collapse ⌄ keeps the shell running', async ({ el }) => {
  const { page } = await launch(el);
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await openTerminal(page);
  const h = () => page.evaluate(() => Math.round(document.querySelector<HTMLElement>('[data-testid="terminal-panel"]')!.getBoundingClientRect().height));
  const editorH = () => page.evaluate(() => Math.round(document.querySelector('.se-editor-area')!.getBoundingClientRect().height));
  const before = await h();
  const rows0 = (await active(page))!.rows;
  await page.getByTestId('terminal-max').click();
  await expect.poll(editorH).toBe(0);
  expect(await h()).toBeGreaterThan(before + 200);
  // The PTY follows the bigger panel, and focus stays in the terminal.
  await expect.poll(async () => (await active(page))!.rows).toBeGreaterThan(rows0 + 5);
  const a = (await active(page))!;
  await page.keyboard.type('stty size\n');
  await expect.poll(() => termText(page)).toContain(`${a.rows} ${a.cols}`);
  await page.getByTestId('terminal-max').click();
  await expect.poll(h).toBe(before);
  expect(await editorH()).toBeGreaterThan(100);

  const pid = (await active(page))!.pid;
  await page.getByTestId('terminal-hide').click();
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  expect((() => { try { process.kill(pid, 0); return true; } catch { return false; } })()).toBe(true);
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.se-term-tab')).toHaveCount(1);
  expect((await active(page))!.pid).toBe(pid);
});

test('terminal colours follow the app theme live', async ({ el }) => {
  const { page } = await launch(el);
  await openTerminal(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('.se-term-view .xterm-scrollable-element')!).backgroundColor);
  const before = await bg();
  await page.getByLabel('Toggle theme').click();
  await expect.poll(bg).not.toBe(before);
  const card = await page.evaluate(() => getComputedStyle(document.querySelector('.se-content')!).backgroundColor);
  expect(await bg()).toBe(card); // the terminal is part of the editor card
});

/** Screenshot profiles: Windows ones shown on Linux (all run /bin/bash) — SEC_EDIT_TEST_SHELLS is test-only. */
const SHOT_SHELLS = JSON.stringify([
  { id: 'pwsh', name: 'PowerShell 7', kind: 'pwsh', path: '/bin/bash', args: [], detail: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
  { id: 'powershell', name: 'Windows PowerShell', kind: 'powershell', path: '/bin/bash', args: [], detail: 'PowerShell 5.1 · built into Windows' },
  { id: 'cmd', name: 'Command Prompt', kind: 'cmd', path: '/bin/bash', args: [], detail: 'cmd.exe' },
  { id: 'gitbash', name: 'Git Bash', kind: 'gitbash', path: '/bin/bash', args: [], detail: 'C:\\Program Files\\Git\\bin\\bash.exe' },
  { id: 'wsl:Ubuntu-24.04', name: 'Ubuntu 24.04', kind: 'wsl', path: '/bin/bash', args: [], detail: 'WSL · Ubuntu-24.04' },
  { id: 'wsl:kali-linux', name: 'Kali Linux', kind: 'wsl', path: '/bin/bash', args: [], detail: 'WSL · kali-linux' },
]);

test('screenshots: shelf + classic, dark + light — tabs, launcher card, empty state, maximized', async ({ el }) => {
  test.skip(!process.env.SEC_EDIT_SHOTS, 'set SEC_EDIT_SHOTS=<dir>');
  test.setTimeout(240000);
  const out = process.env.SEC_EDIT_SHOTS!;
  const only = process.env.SEC_EDIT_SHOTS_ONLY; // e.g. "shelf-dark" while iterating
  const bin = path.join(el.tmp, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  await fsp.writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "Claude Code (stand-in)"\nexec cat\n', { mode: 0o755 });
  await fsp.mkdir(el.userData, { recursive: true });
  for (const style of ['shelf', 'classic'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      if (only && only !== `${style}-${theme}`) continue;
      await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ sidebarStyle: style, theme }));
      const { app, page } = await launch(el, { SEC_EDIT_TEST_SHELLS: SHOT_SHELLS, PATH: `${bin}:${process.env.PATH}` });
      const shot = (name: string) => page.screenshot({ path: path.join(out, `terminal-${style}-${theme}-${name}.png`) });
      await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
      // Empty panel + launcher card (palette → "Terminal: New terminal with…").
      await page.keyboard.press('Control+Shift+p');
      await page.keyboard.type('new terminal with');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-launcher')).toBeVisible();
      await expect(page.getByTestId('terminal-launcher').locator('.se-term-lrow', { hasText: 'Claude Code' })).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(250);
      await shot('launcher');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('terminal-empty')).toBeVisible();
      await page.mouse.move(5, 400);
      await page.waitForTimeout(200);
      await shot('empty');
      // Tabs: the default profile, a WSL one, Claude Code.
      await page.locator('.se-term-tile.is-default').click();
      await expect.poll(() => termText(page), { timeout: 15000 }).toContain('term$');
      await page.getByTestId('terminal-shells').click();
      await page.getByTestId('terminal-launcher').locator('.se-term-lrow', { hasText: 'Ubuntu 24.04' }).click();
      await page.getByTestId('terminal-shells').click();
      await page.getByTestId('terminal-launcher').locator('.se-term-lrow', { hasText: 'Claude Code' }).click();
      await expect(page.locator('.se-term-tab')).toHaveCount(3);
      await page.locator('.se-term-tab').first().click();
      await page.keyboard.type(`clear; printf '\\033[1;32m✔ build ok\\033[0m  \\033[33mwarn\\033[0m  \\033[31merror\\033[0m  \\033[34mblue\\033[0m  \\033[35mmagenta\\033[0m  \\033[36mcyan\\033[0m\\n'; echo "see code/app.ts:2:7"; ls -la --color=always\n`);
      await page.waitForTimeout(700);
      await page.getByTestId('terminal-more').hover();
      await page.waitForTimeout(200);
      await shot('tabs');
      await page.getByTestId('terminal-max').click();
      await page.waitForTimeout(400);
      await shot('max');
      await app.close();
    }
  }
});

test('GPU: "auto" stays on the DOM renderer with software WebGL; "on" uses WebGL and falls back to DOM on context loss', async ({ el }) => {
  const { page } = await launch(el);
  await openTerminal(page);
  const renderer = () => page.evaluate(() => (window as any).__secEditTerminal.manager.active.view.renderer());
  await page.waitForTimeout(1500); // the renderer is chosen on idle after open
  expect(await renderer()).toBe('dom'); // Xvfb: SwiftShader only → auto keeps the DOM renderer
  await page.evaluate(() => {
    const a = (window as any).__secEdit;
    a.settings.value = { ...a.settings.value, 'terminal.gpuAcceleration': 'on' };
    a.events.emit('settings:changed', a.settings.value);
  });
  await expect.poll(renderer, { timeout: 10000 }).toBe('webgl');
  await page.keyboard.type('echo GPU=$((20+22))\n');
  await expect.poll(() => page.evaluate(() => (window as any).__secEditTerminal.manager.active.view.allText())).toContain('GPU=42');
  // Lost GPU context (driver reset, sleep): back to the DOM renderer, the terminal keeps working.
  await page.evaluate(() => {
    // The WebGL layer is the canvas whose (existing) context is WebGL2; the others are 2D layers.
    const gl = [...document.querySelectorAll<HTMLCanvasElement>('.se-term-view canvas')].map((c) => c.getContext('webgl2')).find(Boolean)!;
    gl.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect.poll(renderer, { timeout: 10000 }).toBe('dom');
  await page.keyboard.type('echo AFTER=$((1+1))\n');
  await expect.poll(() => termText(page)).toContain('AFTER=2');
});
