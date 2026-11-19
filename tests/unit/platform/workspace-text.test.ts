// @vitest-environment happy-dom
// The paged, shared workspace text stream feeding the search + knowledge indexers.
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../../src/renderer/app/app';
import { readAllTextShared, streamAllText } from '../../../src/renderer/app/workspace-text';
import type { FileData, TextPageOptions } from '../../../src/shared/api';

const file = (i: number): FileData => ({ path: `n${String(i).padStart(3, '0')}.md`, content: `note ${i}`, mtime: i, eol: 'lf' });
const ALL = Array.from({ length: 25 }, (_, i) => file(i));

let calls: TextPageOptions[] = [];
let gate: Promise<void> = Promise.resolve();

beforeEach(() => {
  calls = [];
  gate = Promise.resolve();
  app.workspace.value = { root: '/ws', name: 'ws' };
  app.backend = {
    readAllText: async () => {
      throw new Error('paged backends must not use readAllText');
    },
    readAllTextPage: async (opts: TextPageOptions = {}) => {
      calls.push(opts);
      if (opts.cursor) await gate; // only later pages wait: lets a test join mid-stream
      const start = opts.cursor ? ALL.findIndex((f) => f.path > opts.cursor!) : 0;
      const files = ALL.slice(start, start + 10);
      const end = start + files.length;
      return { files, nextCursor: end < ALL.length ? ALL[end - 1].path : null };
    },
  } as any;
});

async function collect(it: AsyncIterable<FileData[]>) {
  const pages: FileData[][] = [];
  for await (const p of it) pages.push(p);
  return pages;
}

describe('streamAllText', () => {
  it('yields every page in order, asking ~4 MB pages (one IPC round trip each) with the previous cursor', async () => {
    const pages = await collect(streamAllText());
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
    expect(pages.flat()).toEqual(ALL);
    expect(calls.map((c) => c.cursor ?? null)).toEqual([null, 'n009.md', 'n019.md']);
    expect(calls.every((c) => c.maxBytes === 4 << 20)).toBe(true);
  });

  it('concurrent consumers share one read; a late joiner replays earlier pages', async () => {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const a = collect(streamAllText());
    const b = readAllTextShared();
    await new Promise((r) => setTimeout(r, 0)); // page 1 delivered, page 2 held
    expect(calls.length).toBe(2);
    const c = collect(streamAllText()); // joins mid-stream
    open();
    expect((await a).flat()).toEqual(ALL);
    expect(await b).toEqual(ALL);
    expect((await c).flat()).toEqual(ALL);
    expect(calls.length).toBe(3);
    // Finished reads are not cached: the next rebuild sees fresh disk content.
    await collect(streamAllText());
    expect(calls.length).toBe(6);
  });

  it('a different workspace starts its own read', async () => {
    const a = collect(streamAllText());
    app.workspace.value = { root: '/other', name: 'other' };
    const b = collect(streamAllText());
    await Promise.all([a, b]);
    expect(calls.length).toBe(6);
  });

  it('errors reach every consumer', async () => {
    (app.backend as any).readAllTextPage = async () => {
      throw Object.assign(new Error('boom'), { code: 'EIO' });
    };
    await expect(collect(streamAllText())).rejects.toThrow('boom');
    await expect(readAllTextShared()).rejects.toThrow('boom');
  });

  it('falls back to readAllText on backends without paging', async () => {
    app.backend = { readAllText: async () => ALL } as any;
    expect(await collect(streamAllText())).toEqual([ALL]);
  });
});
