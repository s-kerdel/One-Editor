// Service-level data-safety and input checks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendService } from '../../../src/backend/service';

const TMP = fileURLToPath(new URL('../../../.tmp/review/unit', import.meta.url));
let tmp: string;
let root: string;
beforeEach(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(TMP, 'svc-'));
  root = path.join(tmp, 'notes');
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, 'a.md'), 'A');
});
afterEach(async () => {
  delete process.env.SEC_EDIT_TRASH_DIR;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('trash', () => {
  it('when the OS trash refuses (Windows: USB/network drive) the file is kept and the UI gets ETRASH', async () => {
    // A fallback "trash" that would really delete: it must not be reached.
    process.env.SEC_EDIT_TRASH_DIR = path.join(tmp, 'fallback-trash');
    const s = new BackendService(path.join(tmp, 'cfg'), {
      trash: async () => Promise.reject(new Error('Item could not be recycled')),
      trashIsAuthoritative: true,
    });
    await s.openWorkspace(root);
    await expect(s.remove('a.md')).rejects.toMatchObject({ code: 'ETRASH' });
    expect(fs.existsSync(path.join(root, 'a.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'fallback-trash'))).toBe(false);
    s.dispose();
  });
});

describe('openExternal', () => {
  it('passes only web/mail URLs to the OS', async () => {
    const opened: string[] = [];
    const s = new BackendService(path.join(tmp, 'cfg'), { openExternal: async (u) => void opened.push(u) });
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'javascript:alert(1)', 'http:', 'C:\\x.exe']) {
      await expect(s.openExternal(bad), bad).rejects.toMatchObject({ code: 'EIO' });
    }
    await s.openExternal('https://example.com/a b');
    await s.openExternal('mailto:me@example.com');
    expect(opened).toHaveLength(2);
    s.dispose();
  });
});

describe('RPC argument types', () => {
  it('non-string paths are rejected cleanly', async () => {
    const s = new BackendService(path.join(tmp, 'cfg'));
    await s.openWorkspace(root);
    for (const bad of [{}, ['a.md'], 42, null]) await expect(s.readFile(bad as any)).rejects.toBeTruthy();
    expect((await s.readFile('a.md')).content).toBe('A');
    s.dispose();
  });
});
