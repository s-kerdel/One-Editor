// One workspace-wide text read shared by the background indexers (search, knowledge). On a big
// folder the payload is tens of MB, so it arrives in ~1 MB pages (readAllTextPage): no single huge
// response to parse (that was a 150–250 ms main-thread task on 12k files), and the indexers start
// working on the first page while the backend reads the rest. Concurrent consumers share one read.
import type { FileData } from '@shared/api';
import { app } from './app';

/** Page size asked from the backend (content length). Each page is one IPC round trip (~20 ms in
 *  Electron whatever the size, measured): 4 MB pages cut a 26 MB folder's round trips from 26 to 7,
 *  and still clone / parse in ~10 ms (consumers slice further before posting to their workers). */
const PAGE_BYTES = 4 << 20;

/** A page plus the pass's progress (files examined so far / indexable files in the pass). */
export interface TextPageMeta {
  files: FileData[];
  done?: number;
  total?: number;
}

interface Feed {
  root: string;
  pages: TextPageMeta[];
  done: boolean;
  error: unknown;
  wake: Array<() => void>;
}

let current: Feed | null = null;

function startFeed(root: string): Feed {
  const feed: Feed = { root, pages: [], done: false, error: null, wake: [] };
  const notify = () => feed.wake.splice(0).forEach((f) => f());
  void (async () => {
    try {
      const be = app.backend;
      if (typeof be.readAllTextPage !== 'function') {
        feed.pages.push({ files: await be.readAllText() }); // older / mocked backends
      } else {
        let cursor: string | null = null;
        do {
          // Fetches run ahead of the consumers: the backend reads page n+1 while page n is indexed.
          const page: { files: FileData[]; nextCursor: string | null; done?: number; total?: number } = await be.readAllTextPage({ cursor, maxBytes: PAGE_BYTES });
          if (page.files.length || !feed.pages.length) feed.pages.push({ files: page.files, done: page.done, total: page.total });
          cursor = page.nextCursor;
          notify();
        } while (cursor);
      }
    } catch (err) {
      feed.error = err;
    } finally {
      feed.done = true;
      // Only de-duplicate while the read is in flight: a later rebuild must see fresh disk content.
      if (current === feed) current = null;
      notify();
    }
  })();
  return feed;
}

/**
 * Every text file of the workspace (large/binary files skipped), page by page in path order.
 * A consumer joining while a read is in flight replays the pages received so far.
 */
export async function* streamAllText(): AsyncGenerator<FileData[], void, void> {
  for await (const p of streamAllTextPages()) if (p.files.length) yield p.files;
}

/** streamAllText with progress (the first page always comes, possibly empty, and carries the total). */
export async function* streamAllTextPages(): AsyncGenerator<TextPageMeta, void, void> {
  const root = app.workspace.value?.root ?? '';
  const feed = current?.root === root ? current : (current = startFeed(root));
  for (let i = 0; ; ) {
    if (i < feed.pages.length) {
      yield feed.pages[i++];
      continue;
    }
    if (feed.error) throw feed.error;
    if (feed.done) return;
    await new Promise<void>((r) => feed.wake.push(r));
  }
}

/** Like `app.backend.readAllText()` (one array), but shares the paged read with the indexers. */
export async function readAllTextShared(): Promise<FileData[]> {
  const out: FileData[] = [];
  for await (const page of streamAllText()) for (const f of page) out.push(f);
  return out;
}
