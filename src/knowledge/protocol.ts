// Messages between the renderer (knowledge extractor client) and the extraction worker.
import type { NoteInfo } from './extract';

export interface ExtractDoc {
  path: string;
  text: string;
}

export type ToKnowledgeWorker = { type: 'extract'; id: number; docs: ExtractDoc[] };

export type FromKnowledgeWorker = { type: 'extracted'; id: number; infos: NoteInfo[] } | { type: 'error'; id: number; message: string };
