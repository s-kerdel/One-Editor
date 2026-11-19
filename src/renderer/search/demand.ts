// Settings → Search → "Build the index": 'launch' (default) builds once the app is idle after boot;
// 'onDemand' waits for the first consumer — the search panel / find in files, quick-open content hits,
// workspace headings, backlinks / tags / graph / unlinked mentions, [[ / # completion, link updates
// on rename. Until then no index worker, reader thread or search shard runs. Startup code: keep tiny.
import { signal } from '@preact/signals';
import { app } from '../app/app';

export const indexOnDemand = () => app.settings.value['search.indexing'] === 'onDemand';

/** On demand and nothing has asked for the index yet (status bar: "Search index: on demand"). */
export const indexDeferred = signal(false);

let started = false;
/** The search client's first start(): from then on the index stays live for the session. */
export function markIndexStarted() {
  started = true;
  indexDeferred.value = false;
}
export const indexStarted = () => started;
