// @vitest-environment happy-dom
// Renderer side of names that differ only in case. Whether "Note.md" and "note.md" are one file is the
// backend's per-folder probe (WorkspaceInfo.caseSensitive), never the OS: a WSL root on Windows keeps both.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@shared/api';
import type { GitEntry } from '@shared/git';
import { app } from '../../../src/renderer/app/app';
import { caseTwin, commitCreateNow, deletePathsNow, foldsCase, renameToNow } from '../../../src/renderer/app/Popups';
import { findNode } from '../../../src/renderer/app/tree-model';
import { GitStore } from '../../../src/renderer/git/store';
import { RpcError } from '../../../src/renderer/platform';

const file = (path: string): TreeNode => ({ name: path.split('/').pop()!, path, kind: 'file' });
const calls: string[] = [];

function setup(os: 'win32' | 'linux', caseSensitive: boolean) {
  calls.length = 0;
  app.workspace.value = { root: os === 'win32' ? '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes' : '/home/me/notes', name: 'notes', caseSensitive };
  app.tree.value = {
    name: 'notes',
    path: '',
    kind: 'dir',
    children: [{ name: 'Docs', path: 'Docs', kind: 'dir', children: [file('Docs/a.md')] }, file('Note.md'), file('other.md')],
  };
  app.settings.value = { ...app.settings.value, confirmDelete: false };
  app.openFile = async () => {};
  app.backend = {
    os,
    createFile: async (p: string) => (calls.push(`createFile ${p}`), { mtime: 1 }),
    createDir: async (p: string) => void calls.push(`createDir ${p}`),
    rename: async (a: string, b: string) => void calls.push(`rename ${a} ${b}`),
    remove: async (p: string) => {
      calls.push(`remove ${p}`);
      if (p === 'gone.md') throw new RpcError('ENOENT', `Not found: ${p}`);
    },
    saveSession: async () => {},
  } as never;
}
const names = (dir = '') => (findNode(app.tree.value, dir)?.children ?? []).map((c) => c.name);

beforeEach(() => vi.restoreAllMocks());

describe('(a) win32 + case-sensitive WSL root', () => {
  beforeEach(() => setup('win32', true));

  it('creating note.md next to Note.md (and docs/ next to Docs/) makes a second entry', async () => {
    expect(foldsCase()).toBe(false);
    expect(caseTwin('note.md')).toBe(null);
    expect(await commitCreateNow('', 'file', 'note')).toBe(null);
    expect(await commitCreateNow('', 'dir', 'docs')).toBe(null);
    expect(calls).toEqual(['createFile note.md', 'createDir docs']);
    expect(names()).toEqual(['Docs', 'docs', 'Note.md', 'note.md', 'other.md']);
  });

  it('renaming other.md → NOTE.md is a plain rename; Note.md → note.md is refused while note.md exists', async () => {
    expect(await renameToNow('other.md', 'NOTE.md')).toBe(null);
    await commitCreateNow('', 'file', 'note');
    calls.length = 0;
    // Before: "case-only" was decided by folding the names, so this went to the backend as a case-only rename.
    expect(await renameToNow('Note.md', 'note.md')).toMatch(/already exists/);
    expect(calls).toEqual([]);
  });

  it('git marks do not leak between twins (deleted note.md does not strike through Note.md)', () => {
    const entries: GitEntry[] = [{ path: 'note.md', state: 'deleted' }, { path: 'docs', state: 'untracked', dir: true }];
    const store = new GitStore({ gitStatus: async () => ({ ok: true }) as never, gitHeadFile: async () => ({ content: null, oid: null }) }, { foldCase: foldsCase });
    store.status.value = { ok: true, entries } as never;
    expect(store.marks.value.file('note.md')?.state).toBe('deleted');
    expect(store.marks.value.file('Note.md')).toBe(null);
    expect(store.marks.value.file('Docs/a.md')).toBe(null);
    expect(store.marks.value.file('docs/b.md')?.state).toBe('untracked');
  });
});

describe('(b) case-insensitive NTFS root', () => {
  beforeEach(() => setup('win32', false));

  it('creating note.md / docs/ next to Note.md / Docs/ says so and never reaches the backend', async () => {
    expect(foldsCase()).toBe(true);
    expect(await commitCreateNow('', 'file', 'note')).toMatch(/“Note\.md” already exists — names that differ only in case/);
    expect(await commitCreateNow('', 'dir', 'docs')).toMatch(/“Docs” already exists/);
    expect(await renameToNow('other.md', 'NOTE.md')).toMatch(/“Note\.md” already exists/);
    expect(calls).toEqual([]);
    expect(names(), 'no phantom second entry').toEqual(['Docs', 'Note.md', 'other.md']);
  });

  it('a twin the tree does not show yet: the backend refuses, and its message reaches the input', async () => {
    const msg = '“NOTES.md” already exists (the name differs only in case, which this folder treats as the same file)';
    app.backend = { ...app.backend, createFile: async () => Promise.reject(new RpcError('ECASE', msg)) } as never;
    expect(await commitCreateNow('', 'file', 'notes')).toBe(msg);
    expect(names()).toEqual(['Docs', 'Note.md', 'other.md']);
  });

  it('a case-only rename of the file itself is allowed and leaves one entry', async () => {
    expect(await renameToNow('Note.md', 'note.md')).toBe(null);
    expect(calls).toEqual(['rename Note.md note.md']);
    expect(names()).toEqual(['Docs', 'note.md', 'other.md']);
  });

  it('git marks fold case there (the repository may spell a name differently)', () => {
    const store = new GitStore({ gitStatus: async () => ({ ok: true }) as never, gitHeadFile: async () => ({ content: null, oid: null }) }, { foldCase: foldsCase });
    store.status.value = { ok: true, entries: [{ path: 'note.md', state: 'modified' }] } as never;
    expect(store.marks.value.file('Note.md')?.state).toBe('modified');
  });
});

describe('delete', () => {
  it('a row whose file is not there (any more) does not linger', async () => {
    setup('win32', false);
    app.tree.value = { ...app.tree.value!, children: [...app.tree.value!.children!, file('gone.md')] };
    vi.spyOn(app, 'toast').mockImplementation(() => 0);
    await deletePathsNow(['gone.md']);
    expect(calls).toEqual(['remove gone.md']);
    expect(names()).toEqual(['Docs', 'Note.md', 'other.md']);
  });
});
