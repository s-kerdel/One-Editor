// Path-safety rules, exercised with path.win32 so the Windows behaviour is covered on Linux CI.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { escapesRoot, isInsideDir, relativeInside, resolveInside, watchHint, windowsNameProblem } from '../../../src/backend/pathsafe';

const W = path.win32;
const ROOT = 'C:\\Users\\me\\notes';
const win = (rel: string) => resolveInside(ROOT, rel, W, true);
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (err: any) {
    return err.code;
  }
};

describe('resolveInside (Windows)', () => {
  it('maps normal paths, mixed separators and unicode names inside the root', () => {
    expect(win('a/b.md')).toBe('C:\\Users\\me\\notes\\a\\b.md');
    expect(win('a\\b.md')).toBe('C:\\Users\\me\\notes\\a\\b.md');
    expect(win('Café #1 % 100?/x.md'.replace('?', ''))).toBe('C:\\Users\\me\\notes\\Café #1 % 100\\x.md');
    expect(win('📝 notes/ideas.md')).toBe('C:\\Users\\me\\notes\\📝 notes\\ideas.md');
    expect(win('')).toBe(ROOT);
  });

  it('clamps traversal to the root', () => {
    expect(win('../../Windows/win.ini')).toBe('C:\\Users\\me\\notes\\Windows\\win.ini');
    expect(win('..\\..\\..\\x')).toBe('C:\\Users\\me\\notes\\x');
    expect(win('a/../../b')).toBe('C:\\Users\\me\\notes\\b');
  });

  it('refuses drive letters, UNC, device and long-path prefixes, ADS', () => {
    expect(code(() => win('C:\\Windows\\win.ini'))).toBe('EINVAL');
    expect(code(() => win('C:..\\x'))).toBe('EINVAL');
    expect(code(() => win('D:/x.md'))).toBe('EINVAL');
    expect(code(() => win('\\\\?\\C:\\x'))).toBe('EINVAL');
    expect(win('\\\\.\\PhysicalDrive0')).toBe('C:\\Users\\me\\notes\\PhysicalDrive0'); // device namespace collapses to a name
    expect(code(() => win('note.md:hidden'))).toBe('EINVAL');
    // UNC collapses to a plain relative path *inside* the root (never reaches another machine).
    expect(win('\\\\server\\share\\x.md')).toBe('C:\\Users\\me\\notes\\server\\share\\x.md');
  });

  it('refuses reserved device names, with or without extension, and trailing dots/spaces', () => {
    for (const bad of ['CON', 'nul', 'aux.md', 'Com1.txt', 'LPT9.tar.gz', 'con .md', 'COM¹', 'conin$', 'notes/prn.md', 'a.md.', 'a.md ', 'folder./x.md', '...']) {
      expect(code(() => win(bad)), bad).toBe('EINVAL');
    }
    for (const fine of ['console.md', 'nullable.ts', 'aux-notes.md', 'com10.md', 'lpt.md', 'a.b.md', '.gitignore', '..notes/a.md']) {
      expect(code(() => win(fine)), fine).toBe('ok');
    }
  });

  it('only applies Windows name rules on Windows', () => {
    expect(resolveInside('/home/me/notes', 'aux.md', path.posix, false)).toBe('/home/me/notes/aux.md');
    expect(resolveInside('/home/me/notes', 'C:/x', path.posix, false)).toBe('/home/me/notes/C:/x');
  });
});

describe('escapesRoot / relativeInside / isInsideDir', () => {
  it('treats names starting with ".." as inside', () => {
    expect(escapesRoot('..notes', W)).toBe(false);
    expect(escapesRoot('..', W)).toBe(true);
    expect(escapesRoot('..\\x', W)).toBe(true);
    expect(escapesRoot('D:\\x', W)).toBe(true);
    expect(escapesRoot('../x', path.posix)).toBe(true);
    expect(escapesRoot('..x/y', path.posix)).toBe(false);
  });

  it('maps absolute paths back, case-insensitively on Windows', () => {
    expect(relativeInside(ROOT, 'c:\\users\\ME\\notes\\Sub\\a.md', W)).toBe('Sub/a.md');
    expect(relativeInside(ROOT, 'C:\\Users\\me\\notes\\..notes\\a.md', W)).toBe('..notes/a.md');
    expect(relativeInside(ROOT, 'C:\\Users\\me\\other\\a.md', W)).toBeNull();
    expect(relativeInside(ROOT, 'D:\\Users\\me\\notes\\a.md', W)).toBeNull();
    expect(relativeInside(ROOT, '\\\\server\\share\\a.md', W)).toBeNull();
  });

  it('isInsideDir handles siblings with a common prefix', () => {
    expect(isInsideDir('C:\\notes-old\\a.md', 'C:\\notes', W, true)).toBe(false);
    expect(isInsideDir('C:\\NOTES\\a.md', 'C:\\notes', W, true)).toBe(true);
    expect(isInsideDir('C:\\notes', 'C:\\notes', W, true)).toBe(true);
    expect(isInsideDir('/a/..b/c', '/a', path.posix, false)).toBe(true);
  });
});

describe('watchHint', () => {
  it('normalises Windows watcher names and drops alternate data streams', () => {
    expect(watchHint('sub\\dl.zip:Zone.Identifier', W, true)).toBe('sub/dl.zip');
    expect(watchHint('sub\\a.md', W, true)).toBe('sub/a.md');
    expect(watchHint('a/b:c.md', path.posix, false)).toBe('a/b:c.md'); // legal name on Linux
  });
});

describe('windowsNameProblem', () => {
  it('explains the problem', () => {
    expect(windowsNameProblem('a<b')).toMatch(/character/);
    expect(windowsNameProblem('x.')).toMatch(/dot or a space/);
    expect(windowsNameProblem('NUL.md')).toMatch(/reserved/);
    expect(windowsNameProblem('ok.md')).toBeNull();
  });
});
