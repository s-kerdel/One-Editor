// @vitest-environment happy-dom
// Multiple windows, renderer side: file URLs carry the window's key, every in-app folder open asks main
// first (plain = 'here' mode: switch this window; Shift = 'new' mode; only the answer 'here' opens in place),
// and "Window: New window" (Mod-Shift-n) exists only with main's support.
// No key (a main without windows support, browser mode) = everything as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { app } from '../../../src/renderer/app/app';
import { connectBackend, fileUrl } from '../../../src/renderer/platform';
import { openWorkspace } from '../../../src/renderer/app/doc-save';
import { getCommand } from '../../../src/renderer/app/commands';
import { installShell } from '../../../src/renderer/app/shell';
import { Welcome } from '../../../src/renderer/app/Welcome';
import { ContextMenuHost, openWorkspaceMenu } from '../../../src/renderer/app/Popups';
import * as ui from '../../../src/renderer/app/ui';
import { appKeyWinsInTerminal } from '../../../src/renderer/terminal/keys';
import type { BackendApi } from '../../../src/shared/api';

const WS = { root: '/home/u/b', name: 'b' };
const setBackend = (b: Partial<BackendApi> & Record<string, unknown>) => ((app as any).backend = b);
const win = window as unknown as { secEditBridge?: unknown };

function bridge<T extends Record<string, unknown>>(extra: T) {
  return { os: 'linux', invoke: vi.fn(), on: vi.fn(() => () => {}), getPathForFile: vi.fn(), setZoom: vi.fn(), toggleDevTools: vi.fn(), ready: vi.fn(), approveClose: vi.fn(), ...extra };
}

describe('fileUrl', () => {
  it('desktop without a key: the URL as before', () => {
    expect(fileUrl({ kind: 'electron' } as BackendApi, '/w', 'img/a b#1.png')).toBe('app://sec-edit/__ws/img/a%20b%231.png');
  });

  it('desktop with a key: app://sec-edit/__ws/<key>/<rel…>, the key encoded as one segment', () => {
    expect(fileUrl({ kind: 'electron', wsKey: 'k1' } as BackendApi, '/w', 'img/a b.png')).toBe('app://sec-edit/__ws/k1/img/a%20b.png');
    expect(fileUrl({ kind: 'electron', wsKey: 'a/b?' } as BackendApi, '/w', '\\x.png')).toBe('app://sec-edit/__ws/a%2Fb%3F/x.png');
  });
});

describe('the preload bridge', () => {
  afterEach(() => void delete win.secEditBridge);

  it('with a key: wsKey, newWindow and openFolderWindow reach main', async () => {
    const b = bridge({ wsKey: 'k1', newWindow: vi.fn(async () => undefined), openFolderWindow: vi.fn(async () => 'new') });
    win.secEditBridge = b;
    const api = await connectBackend();
    expect(api.wsKey).toBe('k1');
    await api.newWindow!();
    expect(b.newWindow).toHaveBeenCalledOnce();
    expect(await api.openFolderWindow!('/home/u/c')).toBe('new');
    expect(b.openFolderWindow).toHaveBeenCalledWith('/home/u/c', undefined); // the preload makes it 'here'
    await api.openFolderWindow!('/home/u/c', 'new');
    expect(b.openFolderWindow).toHaveBeenLastCalledWith('/home/u/c', 'new');
  });

  it('without a key (a main without windows support): none of them, so the app stays one window', async () => {
    win.secEditBridge = bridge({ wsKey: '', newWindow: vi.fn(), openFolderWindow: vi.fn() });
    const api = await connectBackend();
    expect(api.wsKey).toBeUndefined();
    expect(api.newWindow).toBeUndefined();
    expect(api.openFolderWindow).toBeUndefined();
  });
});

describe('openWorkspace asks main where the folder opens', () => {
  let backend: Record<string, ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    app.workspace.value = { root: '/home/u/a', name: 'a' } as any;
    app.tabs.value = [];
    backend = {
      openWorkspace: vi.fn(async () => WS),
      listTree: vi.fn(async () => ({ name: 'b', path: '', kind: 'dir', children: [] })),
      getSession: vi.fn(async () => null),
      recentWorkspaces: vi.fn(async () => []),
    };
  });

  it("plain: asks in 'here' mode; the answer 'here' switches this window in place", async () => {
    setBackend({ kind: 'electron', ...backend, openFolderWindow: vi.fn(async () => 'here' as const) });
    await openWorkspace('/home/u/b');
    expect(app.backend.openFolderWindow).toHaveBeenCalledWith('/home/u/b', 'here');
    expect(backend.openWorkspace).toHaveBeenCalledWith('/home/u/b');
    expect(app.workspace.value).toEqual(WS);
  });

  it("Shift (newWindow): asks in 'new' mode", async () => {
    setBackend({ kind: 'electron', ...backend, openFolderWindow: vi.fn(async () => 'new' as const) });
    await openWorkspace('/home/u/b', { newWindow: true });
    expect(app.backend.openFolderWindow).toHaveBeenCalledWith('/home/u/b', 'new');
    expect(backend.openWorkspace).not.toHaveBeenCalled();
  });

  it.each(['focused', 'new'] as const)("'%s': another window shows it, this one keeps its folder", async (answer) => {
    setBackend({ kind: 'electron', ...backend, openFolderWindow: vi.fn(async () => answer) });
    await openWorkspace('/home/u/b');
    expect(backend.openWorkspace).not.toHaveBeenCalled();
    expect(app.workspace.value?.root).toBe('/home/u/a');
  });

  it('a refusal from main is thrown (the callers toast it); nothing opens', async () => {
    setBackend({ kind: 'electron', ...backend, openFolderWindow: vi.fn(async () => Promise.reject(new Error('EACCES'))) });
    await expect(openWorkspace('/home/u/b')).rejects.toThrow('EACCES');
    expect(backend.openWorkspace).not.toHaveBeenCalled();
  });

  it('no openFolderWindow (browser mode, older main): in place, as before', async () => {
    setBackend({ kind: 'web', ...backend });
    await openWorkspace('/home/u/b');
    expect(backend.openWorkspace).toHaveBeenCalledWith('/home/u/b');
    expect(app.workspace.value).toEqual(WS);
  });
});

describe('folder switcher: plain switches this window, Shift (click or Enter) opens a new one', () => {
  it('the recent entries pass Shift on to main and say so in their tooltip', async () => {
    const openFolderWindow = vi.fn(async () => 'focused' as const); // nothing else runs here
    setBackend({ kind: 'electron', os: 'linux', openFolderWindow });
    app.workspace.value = { root: '/home/u/a', name: 'a' } as any;
    ui.recentFolders.value = ['/home/u/a', '/home/u/b'];
    const anchor = document.body.appendChild(document.createElement('button'));
    const host = document.body.appendChild(document.createElement('div'));
    act(() => render(<ContextMenuHost />, host));
    const entry = () => [...host.querySelectorAll<HTMLButtonElement>('.se-menu-item')].find((b) => b.querySelector('.se-menu-label')?.textContent === 'b')!;
    const show = () => act(() => openWorkspaceMenu(anchor));

    show();
    expect(entry().title).toBe('Shift+click: open in a new window');
    act(() => void entry().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    await vi.waitFor(() => expect(openFolderWindow).toHaveBeenLastCalledWith('/home/u/b', 'new'));

    show();
    act(() => void entry().dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await vi.waitFor(() => expect(openFolderWindow).toHaveBeenLastCalledWith('/home/u/b', 'here'));

    // Keyboard: ↓ ↓ (Open folder…, then the entry) and Shift+Enter.
    show();
    const menu = host.querySelector<HTMLElement>('.se-menu')!;
    for (const key of ['ArrowDown', 'ArrowDown']) act(() => void menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    act(() => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));
    await vi.waitFor(() => expect(openFolderWindow).toHaveBeenCalledTimes(3));
    expect(openFolderWindow).toHaveBeenLastCalledWith('/home/u/b', 'new');
    act(() => render(null, host));
    host.remove();
    anchor.remove();
  });

  it('browser mode (no windows): no tooltip, a plain in-place switch', () => {
    setBackend({ kind: 'web', os: 'linux' });
    app.workspace.value = { root: '/home/u/a', name: 'a' } as any;
    ui.recentFolders.value = ['/home/u/b'];
    const anchor = document.body.appendChild(document.createElement('button'));
    const host = document.body.appendChild(document.createElement('div'));
    act(() => render(<ContextMenuHost />, host));
    act(() => openWorkspaceMenu(anchor));
    const entry = [...host.querySelectorAll<HTMLButtonElement>('.se-menu-item')].find((b) => b.querySelector('.se-menu-label')?.textContent === 'b')!;
    expect(entry.title).toBe('');
    act(() => render(null, host));
    host.remove();
    anchor.remove();
  });
});

describe('Window: New window (Mod-Shift-n)', () => {
  const shell = (extra: Record<string, unknown>) => {
    setBackend({ kind: 'electron', os: 'linux', onOpenRequest: () => () => {}, ...extra });
    installShell();
  };
  const welcomeText = () => {
    const host = document.createElement('div');
    act(() => render(<Welcome />, host));
    const text = host.textContent ?? '';
    act(() => render(null, host));
    return text;
  };

  it('without newWindow: no command, no start-screen row', () => {
    app.workspace.value = null;
    shell({});
    expect(getCommand('window.new')).toBeUndefined();
    expect(welcomeText()).toContain('New note');
    expect(welcomeText()).not.toContain('New window');
  });

  it('with newWindow: the command runs it; the start screen lists it right after "New note"; it beats a focused terminal', async () => {
    app.workspace.value = null;
    const newWindow = vi.fn(async () => undefined);
    shell({ newWindow });
    const cmd = getCommand('window.new')!;
    expect(cmd).toMatchObject({ title: 'Window: New window', keys: ['Mod-Shift-n'] });
    expect(cmd.when).toBeUndefined(); // also without a folder (the start screen)
    await cmd.run();
    expect(newWindow).toHaveBeenCalledOnce();
    expect(welcomeText()).toMatch(/New note.*New window/);
    expect(appKeyWinsInTerminal('Mod-Shift-n', 'win32')).toBe(true);
    expect(appKeyWinsInTerminal('Mod-Shift-n', 'linux')).toBe(true);
  });
});
