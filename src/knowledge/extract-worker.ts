// Web Worker entry for note metadata extraction (links, tags, headings…). Pure CPU work over note
// texts, kept off the main thread; spawned lazily by src/renderer/knowledge/extractor.ts.
import { extractNote } from './extract';
import type { FromKnowledgeWorker, ToKnowledgeWorker } from './protocol';

const scope = self as unknown as { postMessage(m: FromKnowledgeWorker): void; onmessage: ((e: MessageEvent<ToKnowledgeWorker>) => void) | null };
scope.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'extract') return;
  try {
    scope.postMessage({ type: 'extracted', id: m.id, infos: m.docs.map((d) => extractNote(d.path, d.text)) });
  } catch (err) {
    scope.postMessage({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
  }
};
