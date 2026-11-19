// Worker-thread entry of the Indexer (bundled to a string by scripts/build-node.mjs and started with
// `eval: true`, so it works from inside app.asar and the server bundle alike). Pages and file batches
// go back as UTF-8 JSON bytes (transferred): the host's event loop forwards them without parsing.
import { parentPort, workerData } from 'node:worker_threads';
import { Indexer, type IndexerConfig } from './indexer';
import { encodeTextFrame } from '../shared/textframe';

const port = parentPort!;
const ix = new Indexer(workerData as IndexerConfig);
const enc = new TextEncoder();
ix.onPassStart(() => port.postMessage({ type: 'passStart' }));

port.on('message', async (m: { id?: number; op: string; [k: string]: any }) => {
  try {
    switch (m.op) {
      case 'paths':
        return ix.setPaths(m.snap);
      case 'options':
        return ix.setOptions(m.opts);
      case 'page': {
        const { stamps, files, ...meta } = await ix.page(m.cursor, m.maxBytes);
        const body = encodeTextFrame(meta, files);
        return port.postMessage({ id: m.id, stamps, body, passOpen: meta.nextCursor !== null, lastPass: meta.nextCursor === null ? passStats() : undefined }, [body.buffer as ArrayBuffer]);
      }
      case 'files': {
        const { stamps, ...res } = await ix.readFiles(m.paths);
        const body = enc.encode(JSON.stringify(res));
        return port.postMessage({ id: m.id, stamps, body }, [body.buffer]);
      }
      case 'ignore':
        return port.postMessage({ id: m.id, result: ix.ignoreRules() });
      case 'stats': // process explorer: a peek, not activity (it never keeps this thread from idling)
        return port.postMessage({ id: m.id, result: ix.poolStats() });
      case 'warm':
        return ix.warm();
      case 'dispose':
        ix.dispose();
        return;
    }
  } catch (err) {
    port.postMessage({ id: m.id, error: String((err as Error)?.message ?? err) });
  }
});

function passStats() {
  const p = ix.lastPass;
  return p ? { read: p.read, cached: p.cached } : undefined;
}
