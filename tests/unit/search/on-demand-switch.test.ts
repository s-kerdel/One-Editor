// @vitest-environment happy-dom
// Switching search.indexing from "On demand" to "At launch" while nothing is built: it builds now.
import { describe, expect, it } from 'vitest';
import { app } from '../../../src/renderer/app/app';
import { searchClient } from '../../../src/renderer/search/client';
import { indexDeferred } from '../../../src/renderer/search/demand';
import { installSearch } from '../../../src/renderer/search';

describe('search.indexing switched at runtime', () => {
  it('on demand → at launch starts the build right away', async () => {
    (globalThis as any).Worker = undefined;
    let reads = 0;
    app.backend = { readAllText: async () => (reads++, [{ path: 'a.md', content: 'alpha', mtime: 1, eol: 'lf' as const }]) } as any;
    app.settings.value = { ...app.settings.value, 'search.indexing': 'onDemand' };
    app.workspace.value = { root: '/ws', name: 'ws' } as any;
    installSearch();
    expect(indexDeferred.value).toBe(true);
    app.settings.value = { ...app.settings.value, 'search.indexing': 'launch' };
    for (let i = 0; i < 200 && indexDeferred.value; i++) await new Promise((r) => setTimeout(r, 25)); // the search chunk loads first
    expect(indexDeferred.value).toBe(false);
    await searchClient.whenReady();
    expect(reads).toBeGreaterThan(0);
  }, 20_000);
});
