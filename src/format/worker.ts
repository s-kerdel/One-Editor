// Web Worker host for the format core: Prettier and its plugins never touch the UI thread.
import { formatText } from './core';
import type { FormatRequest, FormatResult } from './types';

export interface WorkerRequest {
  id: number;
  text: string;
  req: FormatRequest;
}
export interface WorkerResponse {
  id: number;
  result?: FormatResult;
  error?: string;
}

const scope = self as unknown as { postMessage(msg: WorkerResponse): void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

scope.onmessage = async (e) => {
  const { id, text, req } = e.data;
  try {
    scope.postMessage({ id, result: await formatText(text, req) });
  } catch (err) {
    scope.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
