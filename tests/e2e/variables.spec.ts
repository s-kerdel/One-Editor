// {{variables}}: chips in live mode (values, hover source, click-to-edit writes variables.md), env /
// target pills, copy + run with resolved text, the missing-values form, multi-target copy, prod tint,
// preview + export resolved (secrets masked), source mode raw, `{{` completion, YAML lint.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';
import { openNote } from './editor-helpers';

const SHOTS = path.resolve('.tmp/vars/shots');
fs.mkdirSync(SHOTS, { recursive: true });

export const VARS = `# Project A variables

Only the first yaml block is data.

\`\`\`yaml
# shared defaults
vars:
  domain: corp.local   # AD domain
  share: ADMIN$
  ns: default
  port: 8080
secrets: [db_pass]
targets:
  DC01:     { ip: 10.0.0.10, user: administrator, os: windows }
  WS01:     { ip: 10.0.0.21, user: alice, os: windows }
  Linux-WS: { ip: 10.0.0.30, user: root, os: ubuntu }
envs:
  lab:
    vars:
      ns: lab
  prod:
    vars:
      ns: prod
\`\`\`
`;

export const RUNBOOK = `# Runbook

Namespace {{ns}} on {{domain}}, share {{share}}, missing {{nope}}.

\`\`\`bash
ssh {{user}}@{{ip}} -p {{port}}
\`\`\`

\`\`\`powershell
Get-ADUser -Server {{WS01.ip}} -Domain {{domain}}
\`\`\`
`;

export function seed(ws: WsFixture, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { 'project-a/variables.md': VARS, 'project-a/runbook.md': RUNBOOK, ...extra };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws.root, rel), text);
  }
}

/** Opens a note and waits until the variables chunk has drawn its chips. */
export async function openWithChips(page: Page, p: string) {
  await openNote(page, p);
  await expect(page.locator('.cm-content .se-var').first()).toBeVisible({ timeout: 10000 });
}

const chip = (page: Page, name: string) => page.locator(`.cm-content .se-var[data-var="${name}"]`);
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test.describe('variables', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('chips show values (also in code), hover names the source, unresolved warn; source mode stays raw', async ({ page, ws }) => {
    seed(ws, { 'project-a/sub/deep/note.md': 'Deep {{domain}} {{ns}}\n' });
    await ws.open(page);
    await openWithChips(page, 'project-a/runbook.md');
    await blur(page);
    await expect(chip(page, 'ns')).toHaveText('default');
    await expect(chip(page, 'domain').first()).toHaveText('corp.local');
    await expect(chip(page, 'WS01.ip')).toHaveText('10.0.0.21');
    await expect(chip(page, 'nope')).toHaveText('{{nope}}?');
    await expect(chip(page, 'nope')).toHaveClass(/se-var-missing/);
    // No target yet: {{ip}} inside the bash block is unresolved.
    await expect(chip(page, 'ip')).toHaveClass(/se-var-missing/);
    await chip(page, 'domain').first().hover();
    await expect(page.locator('.se-var-tip')).toContainText('domain = corp.local');
    await expect(page.locator('.se-var-tip')).toContainText('project-a/variables.md');
    // The file itself is untouched.
    expect(await ws.read('project-a/runbook.md')).toBe(RUNBOOK);
    // Source mode: raw placeholders.
    await page.evaluate(() => (window as any).__secEdit.settings.value.viewMode);
    await page.getByTestId('view-mode').click(); // live → source
    await expect(page.locator('.cm-content .se-var')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('{{ns}}');
    await page.getByTestId('view-mode').click(); // → split: the source pane is raw, the preview resolved
    await expect(page.locator('.se-preview')).toContainText('Namespace default on corp.local');
    await expect(page.locator('.se-preview')).toContainText('ssh {{user}}@{{ip}} -p 8080');
    await expect(page.locator('.cm-content .se-var')).toHaveCount(0);
    // Walk-up: a note two folders below uses project-a/variables.md.
    await page.getByTestId('view-mode').click(); // → reading
    await page.getByTestId('view-mode').click(); // → live
    await openWithChips(page, 'project-a/sub/deep/note.md');
    await blur(page);
    await expect(chip(page, 'domain')).toHaveText('corp.local');
  });

  test('env / target pills switch values live; prod is tinted; the choice survives a reload', async ({ page, ws }) => {
    seed(ws);
    await ws.open(page);
    await openWithChips(page, 'project-a/runbook.md');
    await blur(page);
    const env = page.getByTestId('vars-env');
    const target = page.getByTestId('vars-target');
    await expect(env).toHaveText(/env: none/);
    await expect(target).toHaveText(/no target/);
    await env.click();
    await page.getByRole('option', { name: /^prod/ }).click();
    await expect(env).toHaveText(/env: prod/);
    await expect(env).toHaveClass(/is-danger/);
    await expect(chip(page, 'ns')).toHaveText('prod');
    await target.click();
    await page.getByRole('option', { name: /Linux-WS/ }).click();
    await expect(target).toHaveText(/Linux-WS/);
    await expect(chip(page, 'ip')).toHaveText('10.0.0.30');
    await expect(chip(page, 'user')).toHaveText('root');
    // OS hint on the PowerShell block (linux target), not on the bash one.
    await expect(page.locator('.se-cb-os')).toHaveCount(1);
    await expect(page.locator('.se-cb-os')).toContainText('powershell on a ubuntu target');
    await page.screenshot({ path: path.join(SHOTS, 'live-dark.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.screenshot({ path: path.join(SHOTS, 'live-light.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await openWithChips(page, 'project-a/runbook.md');
    await expect(page.getByTestId('vars-env')).toHaveText(/env: prod/);
    await expect(page.getByTestId('vars-target')).toHaveText(/Linux-WS/);
    await env.click();
    await page.getByRole('option', { name: /^lab/ }).click();
    await expect(page.getByTestId('vars-env')).not.toHaveClass(/is-danger/);
  });

  test('click a chip → edit → the value is written into variables.md (comments kept)', async ({ page, ws }) => {
    seed(ws);
    await ws.open(page);
    await openWithChips(page, 'project-a/runbook.md');
    await blur(page);
    await chip(page, 'domain').first().click();
    const editor = page.getByTestId('var-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('Saves to project-a/variables.md');
    await editor.getByLabel('Value', { exact: true }).fill('lab.local');
    await editor.getByLabel('Value', { exact: true }).press('Enter');
    await expect(chip(page, 'domain').first()).toHaveText('lab.local');
    await expect.poll(() => ws.read('project-a/variables.md')).toContain('  domain: lab.local   # AD domain');
    // A missing one: added to the file (new line in the vars map).
    await chip(page, 'nope').click();
    await editor.getByLabel('Value', { exact: true }).fill('yes-now');
    await editor.getByLabel('Value', { exact: true }).press('Enter');
    await expect(chip(page, 'nope')).toHaveText('yes-now');
    await expect.poll(() => ws.read('project-a/variables.md')).toContain('  port: 8080\n  nope: yes-now\n');
    expect(await ws.read('project-a/runbook.md')).toBe(RUNBOOK);
  });

  test('the note wins: frontmatter overrides variables.md, fence attributes override the note', async ({ page, ws }) => {
    seed(ws, { 'project-a/override.md': '---\nvars:\n  share: C$\ntarget: DC01\n---\nShare {{share}} on {{ip}}\n\n```bash {target=WS01}\nping {{ip}}\n```\n' });
    await ws.open(page);
    await openWithChips(page, 'project-a/override.md');
    await blur(page);
    await expect(chip(page, 'share')).toHaveText('C$');
    await chip(page, 'share').hover();
    await expect(page.locator('.se-var-tip')).toContainText('overridden in this note (project-a/variables.md has ADMIN$)');
    await expect(chip(page, 'ip').first()).toHaveText('10.0.0.10');
    await expect(chip(page, 'ip').nth(1)).toHaveText('10.0.0.21');
  });

  test('copy + run use resolved text; missing values are asked for once and remembered', async ({ page, ws }) => {
    seed(ws);
    await ws.open(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__ran = [];
      w.__secEdit.runInTerminal = async (code: string, o: unknown) => (w.__ran.push({ code, o }), true);
    });
    await openWithChips(page, 'project-a/runbook.md');
    await blur(page);
    // No target: {{user}} / {{ip}} are missing → the form asks; {{port}} is known.
    await page.locator('.se-cb-header .se-cb-copy').first().click();
    const form = page.getByTestId('vars-form');
    await expect(form).toBeVisible();
    await expect(form).toContainText('2 values are missing');
    await form.locator('input[name="user"]').fill('admin');
    await form.locator('input[name="ip"]').fill('192.0.2.7');
    await form.locator('button[type="submit"]').click();
    await expect(form).toBeHidden();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ssh admin@192.0.2.7 -p 8080');
    // Remembered: no form the second time, and the chips show them.
    await expect(chip(page, 'ip')).toHaveText('192.0.2.7');
    await page.locator('.se-cb-header .se-cb-run').first().click();
    await expect.poll(() => page.evaluate(() => (window as any).__ran.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).__ran[0].code)).toBe('ssh admin@192.0.2.7 -p 8080');
    // With a target the target row wins over remembered values.
    await page.getByTestId('vars-target').click();
    await page.getByRole('option', { name: /DC01/ }).click();
    await page.locator('.se-cb-header .se-cb-copy').first().click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ssh administrator@10.0.0.10 -p 8080');
    expect(await ws.read('project-a/variables.md')).toBe(VARS); // nothing saved without the checkbox
  });

  test('missing-values form: "Save to variables.md" writes them; the toggle command shows placeholders', async ({ page, ws }) => {
    seed(ws, { 'project-a/save.md': '```bash\ncurl {{api_url}}/health\n```\n\nLine two {{domain}}\n' });
    await ws.open(page);
    await openWithChips(page, 'project-a/save.md');
    await blur(page);
    await page.locator('.se-cb-header .se-cb-copy').first().click();
    const form = page.getByTestId('vars-form');
    await form.locator('input[name="api_url"]').fill('https://api.lab');
    await form.getByRole('checkbox').check();
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('curl https://api.lab/health');
    await expect.poll(() => ws.read('project-a/variables.md')).toContain('  port: 8080\n  api_url: https://api.lab\n');
    // Show placeholders (palette command) → raw text, toggle back → chips.
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Show values / Show placeholders');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content .se-var')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('{{domain}}');
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Show values / Show placeholders');
    await page.keyboard.press('Enter');
    await expect(chip(page, 'domain')).toHaveText('corp.local');
  });

  test('chips keep the height map exact: clicks below them land on the right line', async ({ page, ws }) => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i} uses {{domain}} and {{share}} and {{port}}`);
    seed(ws, { 'project-a/many.md': `${lines.join('\n')}\n\nThe last line\n` });
    await ws.open(page);
    await openWithChips(page, 'project-a/many.md');
    await blur(page);
    const last = page.locator('.cm-line', { hasText: 'The last line' });
    await last.click({ position: { x: 30, y: 8 } });
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(31);
    // CodeMirror's own geometry agrees with the DOM for a line full of chips.
    const delta = await page.evaluate(() => {
      const v = (window as any).__secEdit.editor.getView();
      const line = v.state.doc.line(20);
      const dom = v.domAtPos(line.from).node as Node;
      const el = (dom.nodeType === 1 ? (dom as HTMLElement) : dom.parentElement!).closest('.cm-line')!;
      // Height map (what clicks are resolved against) vs where the line really is.
      return Math.abs(el.getBoundingClientRect().top - (v.documentTop + v.lineBlockAt(line.from).top));
    });
    expect(delta).toBeLessThan(1.5);
  });

  test('multi-target: copy one resolved command per target', async ({ page, ws }) => {
    seed(ws);
    await ws.open(page);
    await openWithChips(page, 'project-a/runbook.md');
    await blur(page);
    await page.locator('.se-cb-header .se-cb-multi').first().click();
    const dlg = page.getByTestId('vars-targets');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Filter targets').fill('windows');
    await dlg.getByRole('button', { name: 'Select all' }).click();
    await dlg.getByLabel('Filter targets').fill('');
    await page.screenshot({ path: path.join(SHOTS, 'multi-dark.png') });
    await dlg.getByRole('button', { name: /Copy 2 commands/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('# --- DC01 ---\nssh administrator@10.0.0.10 -p 8080\n\n# --- WS01 ---\nssh alice@10.0.0.21 -p 8080');
  });

  test('multi-target: one terminal per target, pre-filled, Enter never pressed', async ({ page, ws }) => {
    seed(ws);
    await ws.open(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__ran = [];
      w.__secEdit.runInTerminal = async (code: string, o: unknown) => (w.__ran.push({ code, o }), true);
    });
    await openWithChips(page, 'project-a/runbook.md');
    await blur(page);
    await page.locator('.se-cb-header .se-cb-multi').first().click();
    const dlg = page.getByTestId('vars-targets');
    await dlg.getByRole('checkbox').nth(1).check();
    await dlg.getByRole('checkbox').nth(2).check();
    await dlg.getByRole('button', { name: /Open 2 terminals/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__ran.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).__ran)).toEqual([
      { code: 'ssh alice@10.0.0.21 -p 8080', o: { lang: 'bash', pressEnter: false } },
      { code: 'ssh root@10.0.0.30 -p 8080', o: { lang: 'bash', pressEnter: false } },
    ]);
  });

  test('secrets (browser: memory only): masked everywhere, asked for on copy, never in exports', async ({ page, ws }) => {
    seed(ws, { 'project-a/secret.md': 'Password {{db_pass}}\n\n```bash\nmysql -p{{db_pass}} -h {{domain}}\n```\n' });
    await ws.open(page);
    await openWithChips(page, 'project-a/secret.md');
    await blur(page);
    await expect(chip(page, 'db_pass').first()).toHaveText('🔒 db_pass');
    await expect(chip(page, 'db_pass').first()).toHaveClass(/se-var-secret-missing/);
    await page.locator('.se-cb-header .se-cb-copy').first().click();
    const form = page.getByTestId('vars-form');
    await expect(form.locator('input[name="db_pass"]')).toHaveAttribute('type', 'password');
    await form.locator('input[name="db_pass"]').fill('Hunter2!');
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('mysql -pHunter2! -h corp.local');
    await expect(chip(page, 'db_pass').first()).toHaveText('••••');
    // Alt + hover reveals.
    await chip(page, 'db_pass').first().hover();
    await page.keyboard.down('Alt');
    await expect(chip(page, 'db_pass').first()).toHaveText('Hunter2!');
    await page.keyboard.up('Alt');
    await expect(chip(page, 'db_pass').first()).toHaveText('••••');
    // Preview + export + copy-as-HTML: masked.
    const html = await page.evaluate(async () => {
      const app = (window as any).__secEdit;
      const hook = app.variables.renderHook('project-a/secret.md', { export: true });
      return hook('pw {{db_pass}}', null);
    });
    expect(html).toBe('pw ••••');
    await page.evaluate(() => (window as any).__secEdit.saveFile());
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Copy as HTML');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('••••');
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('Hunter2');
    await page.getByTestId('view-mode').click();
    await page.getByTestId('view-mode').click(); // split
    await expect(page.locator('.se-preview')).toContainText('Password ••••');
    expect(await page.locator('.se-preview').innerHTML()).not.toContain('Hunter2');
    // Never written anywhere in the workspace.
    for (const f of ['project-a/variables.md', 'project-a/secret.md']) expect(await ws.read(f)).not.toContain('Hunter2');
  });

  test('reading view: values in text + code, copy / for-targets buttons use the raw block; export can stay raw', async ({ page, ws }) => {
    seed(ws);
    await ws.open(page);
    await openWithChips(page, 'project-a/runbook.md');
    await page.getByTestId('vars-target').click();
    await page.getByRole('option', { name: /WS01/ }).click();
    for (let i = 0; i < 3; i++) await page.getByTestId('view-mode').click(); // live → source → split → reading
    const pv = page.locator('.se-preview');
    await expect(pv).toContainText('Namespace default on corp.local, share ADMIN$, missing {{nope}}.');
    await expect(pv).toContainText('ssh alice@10.0.0.21 -p 8080');
    const block = pv.locator('.se-code[data-vars]').first();
    await block.hover();
    await block.locator('.se-code-copy').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ssh alice@10.0.0.21 -p 8080');
    await expect(block.locator('.se-code-multi')).toHaveCount(1);
    await page.screenshot({ path: path.join(SHOTS, 'preview-dark.png') });
    // Settings → Variables → "Fill in values on export" off: exports keep the placeholders.
    const raw = await page.evaluate(() => {
      const app = (window as any).__secEdit;
      app.settings.value = { ...app.settings.value, 'variables.resolveOnExport': false };
      return app.variables.renderHook('project-a/runbook.md', { export: true });
    });
    expect(raw).toBeNull();
  });

  test('{{ completion offers defined names with values; variables.md gets YAML lint markers', async ({ page, ws }) => {
    seed(ws, { 'project-a/new.md': 'Start' });
    await ws.open(page);
    await openWithChips(page, 'project-a/runbook.md');
    await openNote(page, 'project-a/new.md');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' {{dom');
    const opt = page.locator('.cm-tooltip-autocomplete li', { hasText: 'domain' });
    await expect(opt).toBeVisible();
    await expect(opt).toContainText('corp.local');
    await page.waitForTimeout(200); // CM ignores accept keys for 75 ms after the popup opens
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent())).toBe('Start {{domain}}');
    // Broken YAML: lint marker + toast; values keep the last good parse.
    await openNote(page, 'project-a/variables.md');
    await page.evaluate(() => {
      const v = (window as any).__secEdit.editor.getView();
      const doc = v.state.doc.toString();
      const at = doc.indexOf('  port: 8080');
      v.dispatch({ changes: { from: at, to: at + 12, insert: '  port: [8080' } });
    });
    await expect(page.locator('.cm-lintRange-error').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.se-toast', { hasText: 'YAML error' })).toBeVisible();
    await openNote(page, 'project-a/runbook.md');
    await blur(page);
    await expect(chip(page, 'port')).toHaveText('8080');
  });
});
