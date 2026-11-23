import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { folderForOpenedFile } from '../../../src/main/protocol';

const base = { isInside: (c: string, p: string) => c === p || c.startsWith(p + '/'), exists: () => true, dirname: path.posix.dirname };

describe('folderForOpenedFile', () => {
  it('keeps the open folder for a file inside it', () => {
    expect(folderForOpenedFile({ ...base, current: '/w', file: '/w/a.md', recents: ['/w'] })).toBeNull();
  });
  it('keeps the open folder for a file outside it', () => {
    expect(folderForOpenedFile({ ...base, current: '/w', file: '/other/dir/a.md', recents: ['/other'] })).toBeNull();
  });
  it('without a folder: the recent folder that contains the file', () => {
    expect(folderForOpenedFile({ ...base, current: null, file: '/n/sub/a.md', recents: ['/x', '/n'] })).toBe('/n');
  });
  it('without a folder: skips a recent folder that is gone, falls back to the file folder', () => {
    expect(folderForOpenedFile({ ...base, current: null, file: '/n/sub/a.md', recents: ['/n'], exists: () => false })).toBe('/n/sub');
  });
});
