// Window registry, launch routing (planLaunch) and cascade placement: pure, no electron. Windows paths via path.win32.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { WindowRegistry, cascadeBounds, planLaunch, type LaunchInput } from '../../../src/main/windows';
import { isInsideDir } from '../../../src/backend/pathsafe';

type W = { id: number; root: string | null; foldsCase?: boolean };

describe('WindowRegistry', () => {
  const posix = () => new WindowRegistry<W>({ p: path.posix, foldCase: false });
  const win = () => new WindowRegistry<W>({ p: path.win32, foldCase: true });

  it('adds, gets, lists in order and removes', () => {
    const r = posix();
    r.add({ id: 1, root: '/a' });
    r.add({ id: 2, root: null });
    expect(r.get(2)?.root).toBeNull();
    expect(r.all().map((w) => w.id)).toEqual([1, 2]);
    expect(r.remove(1)).toBe(true);
    expect(r.remove(1)).toBe(false);
    expect(r.all().map((w) => w.id)).toEqual([2]);
  });

  it('finds a window by folder: exact on Linux, case-folded on Windows, trailing separator ignored', () => {
    const p = posix();
    p.add({ id: 1, root: '/home/me/Notes' });
    expect(p.byRoot('/home/me/Notes/')?.id).toBe(1);
    expect(p.byRoot('/home/me/notes')).toBeUndefined();
    const w = win();
    w.add({ id: 1, root: null });
    w.add({ id: 2, root: 'C:\\Users\\me\\Notes' });
    expect(w.byRoot('c:\\users\\me\\notes\\')?.id).toBe(2);
    expect(w.byRoot('C:\\Users\\me')).toBeUndefined();
  });

  it("a window's own case rule wins (a case-sensitive WSL folder on Windows)", () => {
    const w = win();
    w.add({ id: 1, root: '\\\\wsl$\\Ubuntu\\home\\Notes', foldsCase: false });
    expect(w.byRoot('\\\\wsl$\\Ubuntu\\home\\notes')).toBeUndefined();
    expect(w.byRoot('\\\\wsl$\\Ubuntu\\home\\Notes')?.id).toBe(1);
  });

  it('reads root live (a getter on the window context)', () => {
    const r = posix();
    let root: string | null = null;
    r.add({ id: 1, get root() { return root; } });
    expect(r.byRoot('/a')).toBeUndefined();
    root = '/a';
    expect(r.byRoot('/a')?.id).toBe(1);
  });

  it('tracks focus: newest window before any focus, then the most recent focus; removed windows drop out', () => {
    const r = posix();
    expect(r.lastFocused()).toBeUndefined();
    r.add({ id: 1, root: '/a' });
    r.add({ id: 2, root: '/b' });
    expect(r.lastFocused()?.id).toBe(2);
    r.noteFocus(1);
    expect(r.lastFocused()?.id).toBe(1);
    r.noteFocus(2);
    r.noteFocus(1);
    r.remove(1);
    expect(r.lastFocused()?.id).toBe(2);
    r.noteFocus(99); // unknown id: ignored
    expect(r.lastFocused()?.id).toBe(2);
  });

  it('lists open folders once, without empty windows', () => {
    const w = win();
    w.add({ id: 1, root: 'C:\\A' });
    w.add({ id: 2, root: null });
    w.add({ id: 3, root: 'c:\\a' });
    w.add({ id: 4, root: 'D:\\B' });
    expect(w.roots()).toEqual(['C:\\A', 'D:\\B']);
  });
});

// The same helpers main passes in.
const posixHelpers = {
  isInside: (c: string, p: string) => isInsideDir(c, p, path.posix, false),
  samePath: (a: string, b: string) => path.posix.resolve(a) === path.posix.resolve(b),
  exists: () => true,
  dirname: path.posix.dirname,
};
const winHelpers = {
  isInside: (c: string, p: string) => isInsideDir(c, p, path.win32, true),
  samePath: (a: string, b: string) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase(),
  exists: () => true,
  dirname: path.win32.dirname,
};
const dir = (abs: string) => ({ abs, kind: 'dir' as const });
const file = (abs: string) => ({ abs, kind: 'file' as const });
const plan = (o: Partial<LaunchInput>) => planLaunch({ paths: [], windows: [], lastFocusedId: null, recents: [], firstLaunch: false, ...posixHelpers, ...o });

describe('planLaunch: no paths', () => {
  it('first launch: the most recent folder, or the start screen without one', () => {
    expect(plan({ firstLaunch: true, recents: ['/r1', '/r2'] })).toEqual([{ kind: 'new-window', folder: '/r1', files: [] }]);
    expect(plan({ firstLaunch: true })).toEqual([{ kind: 'new-window', folder: null, files: [] }]);
  });
  it('later (Shift+click, Start menu, CLI): a new window with the start screen', () => {
    expect(plan({ recents: ['/r1'], windows: [{ id: 1, root: '/r1' }] })).toEqual([{ kind: 'new-window', folder: null, files: [] }]);
  });
  it('first launch with the most recent folder already open: that window comes to the front', () => {
    expect(plan({ firstLaunch: true, recents: ['/r1'], windows: [{ id: 3, root: '/r1' }] })).toEqual([{ kind: 'focus', id: 3 }]);
  });
});

describe('planLaunch: folders', () => {
  it('a folder already open: focus its window; else a new window', () => {
    const windows = [{ id: 1, root: '/a' }, { id: 2, root: '/b' }];
    expect(plan({ windows, paths: [dir('/b/')] })).toEqual([{ kind: 'focus', id: 2 }]);
    expect(plan({ windows, paths: [dir('/c')] })).toEqual([{ kind: 'new-window', folder: '/c', files: [] }]);
  });
  it('a folder inside an open folder is a folder of its own (new window)', () => {
    expect(plan({ windows: [{ id: 1, root: '/a' }], paths: [dir('/a/sub')] })).toEqual([{ kind: 'new-window', folder: '/a/sub', files: [] }]);
  });
  it('an empty (start screen) window is not reused for a launched folder', () => {
    expect(plan({ windows: [{ id: 1, root: null }], lastFocusedId: 1, paths: [dir('/c')] })).toEqual([{ kind: 'new-window', folder: '/c', files: [] }]);
  });
  it('several folders: one window each, the same folder once, in launch order', () => {
    expect(plan({ windows: [{ id: 1, root: '/a' }], paths: [dir('/c'), dir('/a'), dir('/c/')] })).toEqual([
      { kind: 'new-window', folder: '/c', files: [] },
      { kind: 'focus', id: 1 },
    ]);
  });
  it('Windows: the open folder matches whatever the case and trailing backslash', () => {
    const r = planLaunch({ paths: [dir('c:\\users\\me\\notes\\')], windows: [{ id: 7, root: 'C:\\Users\\me\\Notes' }], lastFocusedId: null, recents: [], firstLaunch: false, ...winHelpers });
    expect(r).toEqual([{ kind: 'focus', id: 7 }]);
  });
});

describe('planLaunch: files', () => {
  it("a file inside an open window's folder opens there (deepest folder wins)", () => {
    const windows = [{ id: 1, root: '/w' }, { id: 2, root: '/w/sub' }, { id: 3, root: '/x' }];
    expect(plan({ windows, lastFocusedId: 3, paths: [file('/w/sub/deep/a.md')] })).toEqual([{ kind: 'open-files', id: 2, files: ['/w/sub/deep/a.md'] }]);
    expect(plan({ windows, lastFocusedId: 3, paths: [file('/w/b.md')] })).toEqual([{ kind: 'open-files', id: 1, files: ['/w/b.md'] }]);
  });
  it('a file outside every folder: the last focused window (outside-file tab)', () => {
    const windows = [{ id: 1, root: '/a' }, { id: 2, root: '/b' }];
    expect(plan({ windows, lastFocusedId: 1, paths: [file('/etc/hosts')] })).toEqual([{ kind: 'open-files', id: 1, files: ['/etc/hosts'] }]);
    // Unknown / no focus: the newest window.
    expect(plan({ windows, lastFocusedId: 9, paths: [file('/etc/hosts')] })).toEqual([{ kind: 'open-files', id: 2, files: ['/etc/hosts'] }]);
  });
  it('an outside file goes to an empty window too (the renderer opens its folder there)', () => {
    expect(plan({ windows: [{ id: 1, root: null }], lastFocusedId: 1, paths: [file('/n/a.md')] })).toEqual([{ kind: 'open-files', id: 1, files: ['/n/a.md'] }]);
  });
  it('no window: a new window in the most recent existing folder that contains it, else its own folder', () => {
    expect(plan({ recents: ['/x', '/n'], paths: [file('/n/sub/a.md')] })).toEqual([{ kind: 'new-window', folder: '/n', files: ['/n/sub/a.md'] }]);
    expect(plan({ recents: ['/n'], exists: () => false, paths: [file('/n/sub/a.md')] })).toEqual([{ kind: 'new-window', folder: '/n/sub', files: ['/n/sub/a.md'] }]);
  });
  it('no window, files of different folders: one window, the others as outside tabs (as one window did)', () => {
    expect(plan({ paths: [file('/x/a.md'), file('/y/b.md'), file('/x/c.md')] })).toEqual([{ kind: 'new-window', folder: '/x', files: ['/x/a.md', '/y/b.md', '/x/c.md'] }]);
  });
  it('several files for one window: one step, each file once', () => {
    const windows = [{ id: 1, root: '/w' }];
    expect(plan({ windows, paths: [file('/w/a.md'), file('/w/b.md'), file('/w/a.md')] })).toEqual([{ kind: 'open-files', id: 1, files: ['/w/a.md', '/w/b.md'] }]);
  });
  it('Windows: case-folded containment, drive letters', () => {
    const base = { windows: [{ id: 1, root: 'C:\\Users\\me\\Notes' }, { id: 2, root: 'D:\\Work' }], lastFocusedId: 2, recents: [], firstLaunch: false, ...winHelpers };
    expect(planLaunch({ ...base, paths: [file('c:\\users\\me\\notes\\todo.md')] })).toEqual([{ kind: 'open-files', id: 1, files: ['c:\\users\\me\\notes\\todo.md'] }]);
    expect(planLaunch({ ...base, paths: [file('E:\\x.txt')] })).toEqual([{ kind: 'open-files', id: 2, files: ['E:\\x.txt'] }]);
    // No window: the recent folder, compared case-folded.
    const none = { ...base, windows: [], lastFocusedId: null, recents: ['C:\\Users\\me\\Notes'] };
    expect(planLaunch({ ...none, paths: [file('C:\\USERS\\me\\notes\\a.md')] })).toEqual([{ kind: 'new-window', folder: 'C:\\Users\\me\\Notes', files: ['C:\\USERS\\me\\notes\\a.md'] }]);
  });
});

describe('planLaunch: folders and files in one launch', () => {
  it('files inside a folder this launch opens join that new window, even when listed first', () => {
    expect(plan({ paths: [file('/p/a.md'), dir('/p'), file('/p/sub/b.md')] })).toEqual([{ kind: 'new-window', folder: '/p', files: ['/p/a.md', '/p/sub/b.md'] }]);
  });
  it('deepest wins between an open window and a folder this launch opens', () => {
    const windows = [{ id: 1, root: '/w' }];
    expect(plan({ windows, paths: [dir('/w/sub'), file('/w/sub/a.md'), file('/w/b.md')] })).toEqual([
      { kind: 'new-window', folder: '/w/sub', files: ['/w/sub/a.md'] },
      { kind: 'open-files', id: 1, files: ['/w/b.md'] },
    ]);
  });
  it('a folder already open plus a file in it: one open-files step', () => {
    expect(plan({ windows: [{ id: 1, root: '/w' }], paths: [dir('/w'), file('/w/a.md')] })).toEqual([{ kind: 'open-files', id: 1, files: ['/w/a.md'] }]);
  });
  it('an outside file goes to the window this launch brings to the front, not the last focused one', () => {
    const windows = [{ id: 1, root: '/a' }, { id: 2, root: '/b' }];
    expect(plan({ windows, lastFocusedId: 2, paths: [dir('/c'), file('/etc/hosts')] })).toEqual([{ kind: 'new-window', folder: '/c', files: ['/etc/hosts'] }]);
    expect(plan({ windows, lastFocusedId: 2, paths: [file('/etc/hosts'), dir('/a')] })).toEqual([{ kind: 'open-files', id: 1, files: ['/etc/hosts'] }]);
    // No window at all (first launch with a folder and a file of elsewhere): one window, as before.
    expect(plan({ paths: [dir('/p'), file('/etc/hosts')] })).toEqual([{ kind: 'new-window', folder: '/p', files: ['/etc/hosts'] }]);
  });
  it('steps follow launch order (the last one ends up in front)', () => {
    const windows = [{ id: 1, root: '/a' }];
    expect(plan({ windows, paths: [file('/a/x.md'), dir('/c')] }).map((s) => s.kind)).toEqual(['open-files', 'new-window']);
    expect(plan({ windows, paths: [dir('/c'), file('/a/x.md')] }).map((s) => s.kind)).toEqual(['new-window', 'open-files']);
  });
});

describe('cascadeBounds', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 };
  it('offsets the next window by the step, same size', () => {
    expect(cascadeBounds({ x: 100, y: 80, width: 1280, height: 820 }, screen)).toEqual({ x: 132, y: 112, width: 1280, height: 820 });
    expect(cascadeBounds({ x: 100, y: 80, width: 1280, height: 820 }, screen, 10)).toEqual({ x: 110, y: 90, width: 1280, height: 820 });
  });
  it('wraps back to the work-area corner when it would leave the right or bottom edge', () => {
    expect(cascadeBounds({ x: 620, y: 100, width: 1280, height: 820 }, screen)).toEqual({ x: 0, y: 0, width: 1280, height: 820 });
    expect(cascadeBounds({ x: 100, y: 200, width: 1280, height: 820 }, screen)).toEqual({ x: 0, y: 0, width: 1280, height: 820 });
    // Exactly at the edge still fits.
    expect(cascadeBounds({ x: 608, y: 188, width: 1280, height: 820 }, screen)).toEqual({ x: 640, y: 220, width: 1280, height: 820 });
  });
  it('works on a display that does not start at 0,0 (second monitor, taskbar on top)', () => {
    const right = { x: 1920, y: 40, width: 2560, height: 1400 };
    expect(cascadeBounds({ x: 2000, y: 100, width: 1280, height: 820 }, right)).toEqual({ x: 2032, y: 132, width: 1280, height: 820 });
    // The previous window on another display: start at this one's corner.
    expect(cascadeBounds({ x: 100, y: 100, width: 1280, height: 820 }, right)).toEqual({ x: 1920, y: 40, width: 1280, height: 820 });
  });
  it('never makes a window larger than the work area', () => {
    expect(cascadeBounds({ x: 0, y: 0, width: 2560, height: 1440 }, screen)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
});
