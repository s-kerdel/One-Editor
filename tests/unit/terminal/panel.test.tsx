// @vitest-environment happy-dom
// Terminal panel UI with a fake backend / fake views: states, tabs, rename, shell picker, menu, find.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import * as ui from '../../../src/renderer/app/ui';
import { findOpen, launcherOpen, terminalMenu, TerminalPanel } from '../../../src/renderer/terminal/Panel';
import { panelHeight, panelMax } from '../../../src/renderer/terminal/height';
import { readTerminalSettings } from '../../../src/renderer/terminal/settings';
import { app } from '../../../src/renderer/app/app';
import { unavailableTerminalBackend, DESKTOP_ONLY_REASON } from '../../../src/renderer/terminal/backend';
import { FakeView, flush, managerRig, type Rig } from './fakes';

let root: HTMLElement;
let r: Rig;
let hidden = 0;

async function mount(props: Partial<Parameters<typeof TerminalPanel>[0]> = {}) {
  await act(async () => {
    render(<TerminalPanel manager={r.m} backend={r.b} hasWorkspace onHide={() => void hidden++} {...props} />, root);
  });
}
const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const click = async (el: Element | null, init: MouseEventInit = {}) => {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  });
  await flush();
};

beforeEach(() => {
  FakeView.all = [];
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  // Settings through the app (the launcher's ★ writes them with updateSettings).
  app.settings.value = { ...app.settings.value, 'terminal.defaultShell': '' };
  (app as { backend: unknown }).backend = { saveSettings: async (p: unknown) => p };
  r = managerRig({ settings: () => readTerminalSettings(app.settings.value) });
  hidden = 0;
  findOpen.value = false;
  launcherOpen.value = false;
  panelMax.value = false;
  panelHeight.value = 260;
  ui.picker.value = null;
  ui.contextMenu.value = null;
});
afterEach(() => {
  render(null, root);
});

describe('terminal panel states', () => {
  it('browser build: only the "desktop app only" note, no way to start a shell', async () => {
    await mount({ backend: unavailableTerminalBackend(DESKTOP_ONLY_REASON) });
    expect(q('[data-testid="terminal-note"]')!.textContent).toBe(DESKTOP_ONLY_REASON);
    expect(q('[data-testid="terminal-new"]')).toBeNull();
    expect(q('.se-term-empty')).toBeNull();
    await click(q('[data-testid="terminal-hide"]'));
    expect(hidden).toBe(1);
  });

  it('no folder open: says so', async () => {
    await mount({ hasWorkspace: false });
    expect(q('[data-testid="terminal-note"]')!.textContent).toMatch(/Open a folder/);
  });

  it('empty state: profile tiles (default highlighted) start a terminal; the host then holds its view', async () => {
    await mount({ folderName: 'proj' });
    expect([...r.b.listClaude].sort()).toEqual([false, true]); // the profiles + (only because a Claude tile is shown) the Claude lookup
    expect(q('.se-term-empty-sub')!.textContent).toContain('proj');
    const tiles = qa('.se-term-tile');
    expect(tiles.map((t) => t.querySelector('.se-term-tile-name')!.textContent)).toEqual(['bash', 'zsh', 'Command Prompt']);
    expect(tiles.map((t) => t.classList.contains('is-default'))).toEqual([true, false, false]);
    expect(tiles[0].querySelector('.se-term-tile-detail')!.textContent).toContain('Default');
    expect(tiles[2].querySelector('.se-term-badge')!.getAttribute('data-tone')).toBe('gray');
    const btn = tiles[0];
    await click(btn);
    expect(r.b.spawned).toHaveLength(1);
    expect(qa('.se-term-tab')).toHaveLength(1);
    expect(q('.se-term-host')!.contains(FakeView.all[0].element)).toBe(true);
    expect(q('.se-term-empty')).toBeNull();
  });

  it('shows the last error in the empty state', async () => {
    r.b.fail = new Error('No shell found on this computer');
    await mount();
    await click(qa('.se-term-tile')[0]);
    expect(q('.se-term-error')!.textContent).toBe('No shell found on this computer');
  });
});

describe('terminal tabs', () => {
  it('lists terminals, switches, closes (kills) and renames', async () => {
    await mount();
    await act(async () => {
      await r.m.create();
      await r.m.create({ shellId: 'zsh' });
    });
    let tabs = qa('.se-term-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['bash', 'zsh']);
    expect(tabs[1].classList.contains('active')).toBe(true);
    await click(tabs[0]);
    expect(r.m.activeId.value).toBe(1);
    expect(qa('.se-term-tab')[0].getAttribute('aria-selected')).toBe('true');

    // Rename: double-click → input → Enter.
    await act(async () => {
      tabs[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = q<HTMLInputElement>('.se-term-rename')!;
    input.value = 'server';
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(qa('.se-term-tab')[0].textContent).toBe('server');

    await click(qa('.se-term-tab-close')[1]);
    expect(r.b.kills).toEqual([2]);
    tabs = qa('.se-term-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['server']);
  });

  it('middle-click closes a tab; closing the last one hides the panel', async () => {
    const hideOnEmpty = managerRig({ onEmpty: () => void hidden++ });
    r = hideOnEmpty;
    await mount();
    await act(async () => void (await r.m.create()));
    await act(async () => {
      qa('.se-term-tab')[0].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    });
    await flush();
    expect(r.b.kills).toEqual([1]);
    expect(hidden).toBe(1);
  });
});

describe('shell picker, context menu, find', () => {
  it('▾ opens the launcher card: rows with badge + detail, keyboard navigation, Enter opens, Escape returns focus', async () => {
    await mount();
    await click(q('[data-testid="terminal-shells"]'));
    const card = q('[data-testid="terminal-launcher"]')!;
    expect(card).toBeTruthy();
    const rows = () => qa('.se-term-lrow');
    expect(rows().map((b) => b.querySelector('.se-term-lrow-name')!.textContent)).toEqual(['bash', 'zsh', 'Command Prompt']);
    expect(rows()[2].querySelector('.se-term-lrow-detail')!.textContent).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(document.activeElement).toBe(rows()[0]); // the default profile has focus
    const key = async (k: string) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    await key('ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    await key('End');
    expect(document.activeElement).toBe(rows()[2]);
    await key('ArrowDown'); // wraps
    expect(document.activeElement).toBe(rows()[0]);
    await key('ArrowUp');
    expect(document.activeElement).toBe(rows()[2]);
    await key('Home');
    await key('ArrowDown');
    await act(async () => void (document.activeElement as HTMLElement).click()); // Enter on a button = click
    await flush();
    expect(r.b.spawned.at(-1)!.shellId).toBe('zsh');
    expect(q('[data-testid="terminal-launcher"]')).toBeNull(); // closes after launching

    await click(q('[data-testid="terminal-shells"]'));
    await key('Escape');
    expect(q('[data-testid="terminal-launcher"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="terminal-shells"]'));
  });

  it('★ / D sets the default profile (terminal.defaultShell) and the launcher pill follows', async () => {
    await mount();
    expect(q('[data-testid="terminal-new"]')!.textContent).toContain('bash');
    await click(q('[data-testid="terminal-shells"]'));
    await act(async () => void qa('.se-term-star')[2].click()); // ★ on Command Prompt
    expect(app.settings.value['terminal.defaultShell']).toBe('cmd');
    expect(qa('.se-term-lrow')[2].classList.contains('is-default')).toBe(true);
    expect(q('[data-testid="terminal-new"]')!.textContent).toContain('Command Prompt');
    // Keyboard: D on the focused row.
    await act(async () => void qa('.se-term-lrow')[1].focus());
    await act(async () => void qa('.se-term-lrow')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })));
    expect(app.settings.value['terminal.defaultShell']).toBe('zsh');
    await click(q('[data-testid="terminal-new"]'));
    expect(r.b.spawned.at(-1)!.prefer).toBe('zsh');
    expect(r.m.sessions.value.at(-1)!.shell.id).toBe('zsh');
  });

  it('maximize fills the editor area and restore returns to the previous height', async () => {
    await mount();
    const panel = () => q('[data-testid="terminal-panel"]')!;
    await click(q('[data-testid="terminal-max"]'));
    expect(panel().classList.contains('is-max')).toBe(true); // CSS: flex 1, editor area collapsed (Electron E2E checks the geometry)
    expect(q('[data-testid="terminal-max"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="terminal-max"]')!.getAttribute('aria-label')).toBe('Restore panel size');
    await click(q('[data-testid="terminal-max"]'));
    expect(panel().classList.contains('is-max')).toBe(false);
    expect(panelHeight.value).toBe(260); // the remembered height is untouched
  });

  it('collapse ⌄ hides the panel but keeps every terminal running', async () => {
    await mount();
    await act(async () => {
      await r.m.create();
      await r.m.create();
    });
    await click(q('[data-testid="terminal-hide"]'));
    expect(hidden).toBe(1);
    expect(r.b.kills).toEqual([]);
    expect(r.m.sessions.value.map((x) => x.status.value)).toEqual(['running', 'running']);
  });

  it('⋯ menu: clear, restart (same profile, same tab position), rename, copy all output, open with…, kill', async () => {
    await mount();
    await act(async () => {
      await r.m.create();
      await r.m.create({ shellId: 'zsh' });
    });
    await act(async () => void r.m.activate(1));
    await click(q('[data-testid="terminal-more"]'));
    const labels = () => ui.contextMenu.value!.items.map((i) => i.label ?? '—');
    expect(labels()).toEqual(['Clear', 'Restart', 'Rename…', 'Copy all output', '—', 'Open new terminal with…', '—', 'Kill terminal']);
    const item = (l: string) => ui.contextMenu.value!.items.find((i) => i.label === l)!;

    await act(async () => void (await item('Restart').run!()));
    await flush();
    expect(r.b.kills).toEqual([1]);
    expect(r.m.sessions.value.map((x) => x.shell.id)).toEqual(['bash', 'zsh']); // back in the first slot
    expect(r.m.sessions.value[0].id).toBe(3);

    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    r.b.emitData(r.m.activeId.value!, 'line one\r\nline two\r\n');
    await click(q('[data-testid="terminal-more"]'));
    await act(async () => void (await item('Copy all output').run!()));
    expect(copied).toEqual(['line one\nline two']);

    await click(q('[data-testid="terminal-more"]'));
    await act(async () => void item('Rename…').run!());
    expect(q('.se-term-rename')).toBeTruthy();

    await click(q('[data-testid="terminal-more"]'));
    await act(async () => void item('Open new terminal with…').run!());
    expect(q('[data-testid="terminal-launcher"]')).toBeTruthy();
  });

  it('a second terminal of the same profile is numbered', async () => {
    await mount();
    await act(async () => {
      await r.m.create();
      await r.m.create();
      await r.m.create();
    });
    expect(qa('.se-term-tab-title').map((t) => t.textContent)).toEqual(['bash', 'bash (2)', 'bash (3)']);
  });

  it('right-click menu: copy only with a selection, paste, find, clear, new, kill', async () => {
    await mount();
    await act(async () => void (await r.m.create()));
    let items = terminalMenu(r.m);
    expect(items.filter((i) => i.label).map((i) => [i.label, !!i.disabled])).toEqual([
      ['Copy', true],
      ['Paste', false],
      ['Select all', false],
      ['Find…', false],
      ['Clear', false],
      ['New terminal', false],
      ['Kill terminal', false],
    ]);
    FakeView.all[0].selection = 'abc';
    items = terminalMenu(r.m);
    expect(items[0].disabled).toBe(false);
    await act(async () => {
      q('.se-term-host')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
    });
    expect(ui.contextMenu.value).toMatchObject({ x: 5, y: 6 });
    await act(async () => void items.find((i) => i.label === 'Kill terminal')!.run!());
    expect(r.b.kills).toEqual([1]);
  });

  it('find bar searches the active terminal (Enter / Shift+Enter, case + regex toggles, counts)', async () => {
    await mount();
    await act(async () => void (await r.m.create()));
    await act(async () => void (findOpen.value = true));
    const input = q<HTMLInputElement>('.se-term-find-input')!;
    await act(async () => {
      input.value = 'err';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(q('.se-term-find-count')!.textContent).toBe('1/3');
    await click(q('.se-term-find button[title="Match case"]'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    const v = FakeView.all[0];
    expect(v.found.at(0)).toEqual(['err', 1, { caseSensitive: false, regex: false }]);
    expect(v.found.at(-1)).toEqual(['err', -1, { caseSensitive: true, regex: false }]);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(findOpen.value).toBe(false);
    expect(v.focused).toBe(true);
  });
});
