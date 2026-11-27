// app:// routing, navigation policy, external URLs and argv parsing — posix and win32.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isAppNavigation, isExternalUrl, pathsFromArgs, routeAppUrl } from '../../../src/main/protocol';
import { resolveInside } from '../../../src/backend/pathsafe';

describe('routeAppUrl', () => {
  const R = '/opt/sec-edit/renderer';
  it('serves renderer files and maps / to index.html', () => {
    expect(routeAppUrl('app://sec-edit/', R, path.posix)).toEqual({ kind: 'renderer', file: `${R}/index.html` });
    expect(routeAppUrl('app://sec-edit/assets/a.js', R, path.posix)).toEqual({ kind: 'renderer', file: `${R}/assets/a.js` });
  });

  it('never leaves the renderer dir (encoded dots, slashes, backslashes)', () => {
    for (const u of ['app://sec-edit/..%2F..%2Fetc/passwd', 'app://sec-edit/%2e%2e/%2e%2e/etc/passwd', 'app://sec-edit/assets/..%2F..%2F..%2Fx']) {
      const r = routeAppUrl(u, R, path.posix);
      expect(r.kind === 'error' || (r.kind === 'renderer' && r.file.startsWith(R + '/')), u).toBe(true);
    }
    const W = 'C:\\Apps\\sec-edit\\resources\\app.asar\\dist\\renderer';
    for (const u of ['app://sec-edit/..%5C..%5C..%5CWindows%5Cwin.ini', 'app://sec-edit/C:%5CWindows%5Cwin.ini', 'app://sec-edit/%5C%5Cserver%5Cshare%5Cx']) {
      const r = routeAppUrl(u, W, path.win32);
      expect(r.kind === 'error' || (r.kind === 'renderer' && r.file.toLowerCase().startsWith(W.toLowerCase() + '\\')), `${u} → ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it('turns malformed escapes and foreign hosts into errors instead of throwing', () => {
    expect(routeAppUrl('app://sec-edit/%E0%A4%A', R, path.posix)).toMatchObject({ kind: 'error', status: 400 });
    expect(routeAppUrl('app://evil/index.html', R, path.posix)).toMatchObject({ kind: 'error', status: 404 });
    expect(routeAppUrl('not a url', R, path.posix)).toMatchObject({ kind: 'error' });
  });

  it('workspace URLs decode names with # % ? and spaces; traversal is clamped by the workspace', () => {
    const name = 'a #1 50% ?.png';
    const url = `app://sec-edit/__ws/k1/sub/${encodeURIComponent(name)}`;
    expect(routeAppUrl(url, R, path.posix)).toEqual({ kind: 'workspace', key: 'k1', rel: `sub/${name}` });
    const evil = routeAppUrl('app://sec-edit/__ws/k1/..%2F..%2F..%2FWindows%2Fwin.ini', R, path.posix);
    expect(evil).toMatchObject({ kind: 'workspace', key: 'k1' });
    const rel = (evil as { rel: string }).rel;
    expect(resolveInside('C:\\notes', rel, path.win32, true)).toBe('C:\\notes\\Windows\\win.ini');
    const drive = routeAppUrl('app://sec-edit/__ws/k1/C:%5CWindows%5Cwin.ini', R, path.posix) as { rel: string };
    expect(() => resolveInside('C:\\notes', drive.rel, path.win32, true)).toThrow(/Invalid file name/);
  });

  // Several windows: the first segment is the window's key; main serves only that window's folder.
  it('workspace URLs need a window key segment', () => {
    expect(routeAppUrl('app://sec-edit/__ws/0123abcd/notes/a.png', R, path.posix)).toEqual({ kind: 'workspace', key: '0123abcd', rel: 'notes/a.png' });
    expect(routeAppUrl('app://sec-edit/__ws/0123abcd/', R, path.posix)).toEqual({ kind: 'workspace', key: '0123abcd', rel: '' });
    // The old key-less form (and an empty key) names no window: not found, never "the" folder.
    for (const u of ['app://sec-edit/__ws/pixel.png', 'app://sec-edit/__ws/', 'app://sec-edit/__ws//pixel.png', 'app://sec-edit/__ws']) {
      expect(routeAppUrl(u, R, path.posix), u).toMatchObject(u === 'app://sec-edit/__ws' ? { kind: 'renderer' } : { kind: 'error', status: 404 });
    }
    // An encoded slash in the key is decoded first: the key is then the part before it (and unknown to main).
    expect(routeAppUrl('app://sec-edit/__ws/ab%2Fcd/x.png', R, path.posix)).toEqual({ kind: 'workspace', key: 'ab', rel: 'cd/x.png' });
    expect(routeAppUrl('app://sec-edit/__ws/k1/%E0%A4%A', R, path.posix)).toMatchObject({ kind: 'error', status: 400 });
  });
});

describe('isAppNavigation', () => {
  it('allows only the app itself', () => {
    expect(isAppNavigation('app://sec-edit/index.html')).toBe(true);
    expect(isAppNavigation('app://sec-edit/__ws/evil.html')).toBe(false);
    expect(isAppNavigation('app://sec-edit/__ws/0123abcd/evil.html')).toBe(false);
    expect(isAppNavigation('app://sec-edit/__ws%2F0123abcd%2Fevil.html')).toBe(false);
    expect(isAppNavigation('app://sec-edit/%5F%5Fws/evil.html')).toBe(false);
    expect(isAppNavigation('app://sec-edit.evil.com/')).toBe(false);
    expect(isAppNavigation('file:///C:/notes/a.html')).toBe(false);
    expect(isAppNavigation('https://example.com/')).toBe(false);
    expect(isAppNavigation('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true);
    expect(isAppNavigation('http://localhost:5173/x')).toBe(false);
  });
});

describe('isExternalUrl', () => {
  it('only web and mail links go to the OS', () => {
    expect(isExternalUrl('https://example.com/a?b#c')).toBe(true);
    expect(isExternalUrl('mailto:me@example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'search-ms:query=x', 'vbscript:x', 'data:text/html,x', 'http:', 'HTTPS', '\\\\server\\share']) {
      expect(isExternalUrl(bad), bad).toBe(false);
    }
  });
});

describe('pathsFromArgs (Windows)', () => {
  const W = path.win32;
  const files = new Set(['C:\\notes', 'C:\\notes\\my todo.md', 'C:\\', 'D:\\proj\\sec-edit', 'C:\\notes\\a.md']);
  const o = (extra: Partial<Parameters<typeof pathsFromArgs>[1]> = {}) => ({ cwd: 'C:\\notes', appPath: null, exists: (p: string) => files.has(p), p: W, foldCase: true, ...extra });

  it('packaged: exe + quoted path with spaces + Chromium switches', () => {
    expect(pathsFromArgs(['C:\\Apps\\sec-edit.exe', '--allow-file-access-from-files', 'C:\\notes\\my todo.md', '--original-process-start-time=1'], o())).toEqual(['C:\\notes\\my todo.md']);
  });

  it('resolves relative args against the (second instance) cwd', () => {
    expect(pathsFromArgs(['sec-edit.exe', 'a.md'], o())).toEqual(['C:\\notes\\a.md']);
    expect(pathsFromArgs(['sec-edit.exe', '.'], o())).toEqual(['C:\\notes']);
  });

  it('a drive root from Explorer ("C:\\" → argv `C:"`) still opens', () => {
    expect(pathsFromArgs(['sec-edit.exe', 'C:"'], o({ cwd: 'D:\\' }))).toEqual(['C:\\']);
  });

  it('unpackaged: skips electron.exe and the app dir (case-insensitively)', () => {
    expect(pathsFromArgs(['electron.exe', 'd:\\PROJ\\sec-edit', 'C:\\notes'], o({ appPath: 'D:\\proj\\sec-edit' }))).toEqual(['C:\\notes']);
  });

  it('squirrel / unknown switches and missing paths are ignored', () => {
    expect(pathsFromArgs(['sec-edit.exe', '--squirrel-firstrun', 'C:\\nope.md'], o())).toEqual([]);
  });
});
