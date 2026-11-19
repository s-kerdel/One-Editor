// @vitest-environment happy-dom
// search.indexing = 'onDemand': nothing builds at launch; disk changes before the first build are
// not queued (the first, cache-validated pass picks them up); the first consumer starts the build.
import { describe, expect, it, beforeAll } from 'vitest';
import { app } from '../../../src/renderer/app/app';
import { searchClient } from '../../../src/renderer/search/client';
import { indexDeferred, indexOnDemand } from '../../../src/renderer/search/demand';
import { installSearch } from '../../../src/renderer/search';

let reads = 0;
const disk: Record<string, string> = { 'a.md': 'alpha zebra', 'b.md': 'beta' };

beforeAll(() => {
  (globalThis as any).Worker = undefined; // in-thread fallback
  app.backend = {
    readAllText: async () => (reads++, Object.entries(disk).map(([path, content]) => ({ path, content, mtime: 1, eol: 'lf' as const }))),
    readFile: async (path: string) => (reads++, { path, content: disk[path], mtime: 1, eol: 'lf' as const }),
  } as any;
  app.settings.value = { ...app.settings.value, 'search.indexing': 'onDemand' };
  app.workspace.value = { root: '/ws', name: 'ws' } as any;
  installSearch();
  searchClient.wire();
});

describe('index built on demand', () => {
  it('starts deferred: nothing read, the status bar item shows', () => {
    expect(indexOnDemand()).toBe(true);
    expect(indexDeferred.value).toBe(true);
    expect(searchClient.status.value).toBe('idle');
    expect(reads).toBe(0);
  });

  it('disk changes before the first build are not queued (the first pass reads current files)', async () => {
    app.events.emit('files:changed', Array.from({ length: 5000 }, (_, i) => `gen/${i}.md`));
    app.events.emit('file:updated', 'a.md', 'alpha zebra changed');
    await new Promise((r) => setTimeout(r, 50));
    expect((searchClient as any).refreshPending.size).toBe(0);
    expect(reads).toBe(0);
    expect(searchClient.status.value).toBe('idle');
  });

  it('the first consumer (a search) builds it; it stays live afterwards', async () => {
    const r = await searchClient.search('zebra');
    expect(r!.results.map((x) => x.path)).toEqual(['a.md']);
    expect(indexDeferred.value).toBe(false);
    expect(reads).toBeGreaterThan(0);
    app.events.emit('file:updated', 'c.md', 'gamma zebra');
    expect((await searchClient.search('zebra'))!.results.map((x) => x.path).sort()).toEqual(['a.md', 'c.md']);
  });
});
