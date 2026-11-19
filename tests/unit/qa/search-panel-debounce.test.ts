// @vitest-environment happy-dom
// Regression (QA journey 6): after the index changed while no query was shown, every later keystroke
// was searched with the 250 ms "index refresh" delay instead of the 90 ms typing debounce.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../../src/renderer/app/app';
import { searchClient } from '../../../src/renderer/search/client';
import { installPanelEffects } from '../../../src/renderer/search/SearchPanel';
import { query } from '../../../src/renderer/search/state';

describe('search panel scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('typing keeps its short debounce after index updates; index updates refresh an idle panel', async () => {
    const search = vi.spyOn(searchClient, 'search').mockResolvedValue({ results: [], totalFiles: 0, totalMatches: 0, tookMs: 0 });
    app.sidebarVisible.value = true;
    app.sidebarPanel.value = 'search';
    installPanelEffects();
    await vi.advanceTimersByTimeAsync(500);
    search.mockClear();

    // Index changes while the box is empty (e.g. a file was opened or saved) …
    searchClient.version.value++;
    await vi.advanceTimersByTimeAsync(500);
    expect(search).not.toHaveBeenCalled();

    // … then the user types: the search must start after the typing debounce (90 ms), not 250 ms.
    query.value = 'kubectl';
    await vi.advanceTimersByTimeAsync(120);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe('kubectl');

    query.value = 'kubectl get';
    await vi.advanceTimersByTimeAsync(120);
    expect(search).toHaveBeenCalledTimes(2);

    // Idle panel with a query: an index change re-runs it (live refresh), once.
    searchClient.version.value++;
    await vi.advanceTimersByTimeAsync(200);
    expect(search).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(search).toHaveBeenCalledTimes(3);
  });
});
