// Web Worker entry for one search shard. Spawned lazily by src/renderer/search/client.ts.
// Shard 0 also runs the feeder (pulls text from the backend, routes documents to its peers).
import { SearchHost } from './host';
import { Feeder, fetchJson } from './feeder';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const host = new SearchHost((m) => scope.postMessage(m));
let feeder: Feeder | null = null;
const feederFor = () => (feeder ??= new Feeder((m) => host.handle(m), [], (m) => scope.postMessage(m), fetchJson));

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'peer':
      feederFor().setPeer(m.index, e.ports[0]);
      return;
    case 'feedPort': {
      // Documents routed here by shard 0's feeder.
      const port = e.ports[0];
      port.onmessage = (ev: MessageEvent<ToWorker>) => host.handle(ev.data);
      return;
    }
    case 'feed': {
      const f = feederFor();
      f.cancel();
      void f.feed(m.gen, m.src, m.maxBytes);
      return;
    }
    case 'refresh':
      void feederFor().refresh(m.id, m.src, m.paths, m.shardOf);
      return;
    case 'pause':
      feederFor().pause(m.on);
      return;
    default:
      host.handle(m);
  }
};
scope.postMessage({ type: 'ready' });
