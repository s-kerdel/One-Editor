// Web Worker entry for the search index. Spawned lazily by src/renderer/search/client.ts.
import { SearchHost } from './host';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const host = new SearchHost((m) => scope.postMessage(m));
scope.onmessage = (e) => host.handle(e.data);
scope.postMessage({ type: 'ready' });
