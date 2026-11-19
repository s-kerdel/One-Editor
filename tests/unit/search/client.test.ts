// @vitest-environment happy-dom
import { describe, expect, it, beforeAll } from 'vitest';
import { signal } from '@preact/signals';
import { app } from '../../../src/renderer/app/app';
import { searchClient } from '../../../src/renderer/search/client';

const disk: Record<string, string> = {
  'README.md': '# Welcome\n```bash\ngit push --force-with-lease\n```\n',
  'notes/k.md': 'kubectl get pods',
};

beforeAll(async () => {
  (globalThis as any).Worker = undefined; // force the in-thread fallback (same SearchHost as the worker)
  app.backend = {
    readAllText: async () => Object.entries(disk).map(([path, content]) => ({ path, content, mtime: 1, eol: 'lf' as const })),
    readFile: async (path: string) => {
      if (!(path in disk)) throw new Error('ENOENT');
      return { path, content: disk[path], mtime: 1, eol: 'lf' as const };
    },
  } as any;
  app.workspace.value = { root: '/ws', name: 'ws' };
  searchClient.wire();
  await searchClient.start();
  await searchClient.whenReady();
});

const find = async (q: string) => (await searchClient.search(q))!.results.map((r) => r.path);

describe('search client index sync', () => {
  it('indexes the workspace on start (in-thread fallback when Worker is unavailable)', async () => {
    expect(searchClient.mode.value).toBe('inline');
    expect(searchClient.indexed.value).toBe(2);
    expect(await find('--force-with-lease')).toEqual(['README.md']);
  });

  it('unsaved editor changes are searchable immediately (no debounce wait)', async () => {
    app.docs.set('notes/k.md', { path: 'notes/k.md', saved: disk['notes/k.md'], content: '', mtime: 1, eol: 'lf', dirty: signal(true) });
    app.events.emit('doc:changed', 'notes/k.md', 'kubectl rollout restart --dry-run=client');
    expect(await find('--dry-run=client')).toEqual(['notes/k.md']);
    // a disk change for a dirty open doc must not clobber the live text
    app.events.emit('file:updated', 'notes/k.md', 'old disk text');
    expect(await find('--dry-run=client')).toEqual(['notes/k.md']);
    app.docs.delete('notes/k.md');
  });

  it('file:updated adds / deletes, file:renamed moves, workspace:opened rebuilds', async () => {
    app.events.emit('file:updated', 'new.md', 'brand new zebra');
    expect(await find('zebra')).toEqual(['new.md']);
    app.events.emit('file:renamed', 'new.md', 'moved/new.md');
    expect(await find('zebra')).toEqual(['moved/new.md']);
    app.events.emit('file:updated', 'moved/new.md', undefined);
    expect(await find('zebra')).toEqual([]);
    disk['other.md'] = 'fresh workspace content';
    app.events.emit('workspace:opened', { root: '/ws2', name: 'ws2' });
    await new Promise((r) => setTimeout(r, 0));
    await searchClient.whenReady();
    expect(await find('fresh workspace')).toEqual(['other.md']);
  });

  it('closing a dirty doc re-syncs with disk', async () => {
    app.events.emit('doc:changed', 'README.md', 'discarded edit text');
    expect(await find('discarded edit')).toEqual(['README.md']);
    app.events.emit('doc:closed', 'README.md');
    await new Promise((r) => setTimeout(r, 10));
    expect(await find('discarded edit')).toEqual([]);
    expect(await find('--force-with-lease')).toEqual(['README.md']);
  });

  it('headings are served from the index', async () => {
    const h = await searchClient.headings({ query: 'welc' });
    expect(h[0]).toMatchObject({ path: 'README.md', text: 'Welcome', level: 1 });
  });
});
